import { and, asc, eq, inArray } from "drizzle-orm";
import type OpenAI from "openai";
import { createLLM, defaultModel, defaultSearchModel, getReasoningLevels, getDefaultReasoningEffort, availableModels, buildDisableReasoningParams } from "@/lib/llm";
import { db } from "@/db";
import { messages, threads, users, mcpServers, connections, globalInstructions, folders } from "@/db/schema";
import { getRequestLocale, t } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/types";
import { scrapeUrl, searchWeb } from "@/lib/scraper";
import type { SourceInfo } from "@/lib/scraper";
import { extractUrls } from "@/lib/urlExtract";
import { decideSearch } from "@/lib/searchDecision";
import { searchWikipedia } from "@/lib/wikipedia";
import type { WikipediaResult } from "@/lib/wikipedia";
import { probeToolSupport, warmupToolProbe } from "@/lib/toolProbe";
import type { ToolSupport } from "@/lib/toolProbe";
import { buildMemoryContext } from "@/lib/memoryStore";
import { buildSkillContext } from "@/lib/skillStore";
import { generateMemories } from "@/lib/memory";
import { generateSkillFromConversation } from "@/lib/skillGenerator";
import { extractSkillCandidates } from "@/lib/skillCandidate";
import { readFileSync } from "node:fs";
import { after } from "next/server";
import { getSessionUser } from "@/lib/auth-guards";
import {
  connectMcpServer,
  listMcpTools,
  callMcpTool,
  mcpToolsToOpenAIFormat,
  parseMcpToolFunctionName,
  type McpConnection,
  type McpTool,
} from "@/lib/mcpClient";
import {
  loadConnections,
  getConnectionTools,
  dispatchConnectionTool,
  type ConnectionRow,
} from "@/lib/connections";
import { hasToolCallMarkup, sanitizeToolCallMarkup } from "@/lib/toolCallSanitizer";
import { buildPersonalizationMessage } from "@/lib/personalization";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start the tool probe in the background at process startup,
// hiding the probeToolSupport latency (~750ms) on the first chat request.
warmupToolProbe();

const SEARCH_RESULT_CONTENT_SLICE = 2000;

type Body = {
  threadId: string;
  content?: string;
  systemPrompt?: string;
  model?: string;
  mode?: "send" | "regenerate" | "edit";
  parentMessageId?: string;
  rapid?: boolean;
  timeRange?: "day" | "week" | "month" | "year";
};

type DbMessage = {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
};

type DualTrace = {
  strategy: "cross_review" | "debate";
  modelA: string;
  modelB: string;
  finalModel: string;
  answerA: string;
  answerB: string;
  reviewA?: string;
  reviewB?: string;
  debateTurns?: { speaker: "A" | "B"; model: string; content: string }[];
};

type StreamSend = (event: string, data: unknown) => void;

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const locale = getRequestLocale(req);
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.threadId) return new Response("threadId is required", { status: 400 });

  const [thread] = await db.select().from(threads).where(eq(threads.id, body.threadId));
  if (!thread) return new Response("thread not found", { status: 404 });
  if (thread.userId !== user.id) return new Response("Not found", { status: 404 });

  const allMessages = await db
    .select({
      id: messages.id,
      parentId: messages.parentId,
      role: messages.role,
      content: messages.content,
    })
    .from(messages)
    .where(eq(messages.threadId, body.threadId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  logger.info("chat", "request", {
    threadId: body.threadId,
    model: body.model ?? thread.model ?? "default",
    mode: body.mode ?? "send",
    messageCount: allMessages.length,
  });

  const mode = body.mode ?? "send";
  const prepared = await prepareTurn(body, mode, thread, allMessages);
  if ("error" in prepared) return new Response(prepared.error, { status: prepared.status });

  const llm = createLLM();
  const finalModel = body.model ?? thread.model ?? defaultModel();
  // Resolve global system instruction.
  // Priority: thread override > user default. If both are null, fall back to body.systemPrompt.
  let resolvedGlobalInstruction: string | null = null;
  const threadInstrId = thread.globalInstructionId ?? null;
  const [userRow] = await db
    .select({
      activeInstructionId: users.activeInstructionId,
      personalStyle: users.personalStyle,
      personalWarmth: users.personalWarmth,
      personalEnergy: users.personalEnergy,
      personalStructure: users.personalStructure,
      personalEmoji: users.personalEmoji,
    })
    .from(users)
    .where(eq(users.id, user.id));
  const effectiveInstrId = threadInstrId ?? userRow?.activeInstructionId ?? null;
  if (effectiveInstrId) {
    const [instr] = await db
      .select({ content: globalInstructions.content })
      .from(globalInstructions)
      .where(and(eq(globalInstructions.id, effectiveInstrId), eq(globalInstructions.userId, user.id)));
    resolvedGlobalInstruction = instr?.content?.trim() || null;
  }
  // Folder instruction (via folderId). Whitespace-only is excluded.
  // Ownership check: filter by folders.userId === user.id.
  let folderInstruction: string | null = null;
  if (thread.folderId) {
    const [folder] = await db
      .select({ instruction: folders.instruction })
      .from(folders)
      .where(and(eq(folders.id, thread.folderId), eq(folders.userId, user.id)));
    folderInstruction = folder?.instruction?.trim() || null;
  }
  // Priority: thread-specific systemPrompt > global (thread override or user default) > body
  const baseSystemContent = thread.systemPrompt ?? resolvedGlobalInstruction ?? body.systemPrompt;
  // If a folder instruction exists, prepend it (instruction → systemPrompt order).
  const systemContent = folderInstruction
    ? [folderInstruction, baseSystemContent].filter(Boolean).join("\n")
    : baseSystemContent;

  // Personalization message (per user). Disabled if personalStyle is null.
  const personalizationContent = buildPersonalizationMessage(
    userRow?.personalStyle ?? null,
    userRow?.personalWarmth ?? 1,
    userRow?.personalEnergy ?? 1,
    userRow?.personalStructure ?? 1,
    userRow?.personalEmoji ?? 1,
  );

  // Start the tool probe early to overlap with in-stream parallel processing.
  // warmupToolProbe() already started the probe at module load, but we also
  // start it here in case it hasn't completed yet (resolves immediately if cached).
  // Not used in rapid/dual mode, but the probe itself is harmless (cached).
  const toolSupportPromise: Promise<ToolSupport | null> = body.rapid
    ? Promise.resolve(null)
    : probeToolSupport(llm, finalModel).catch(() => null);

  // Promise to wait for stream completion. after() callback runs
  // generateMemories within the request context, so we pass the
  // content after the stream completes.
  let resolveStream!: () => void;
  const streamDone = new Promise<void>((resolve) => {
    resolveStream = resolve;
  });
  const streamResult: { assistantContent: string } = { assistantContent: "" };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const streamStartedAt = Date.now();
      const send: StreamSend = (event, data) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      let assistantContent = "";
      let assistantReasoning = "";
      let dualTrace: DualTrace | undefined;
      let mcpConnections: McpConnection[] = [];

      try {
        send("start", { userMessageId: prepared.userMessage.id });
        // Run pre-stream processing in parallel to reduce first-token latency.
        // Each build* is wrapped with .catch(() => null) to isolate failures.
        // rapid mode skips all (null).
        const [searchContextMessage, urlContextMessage, memoryMessage, skillMessage] =
          body.rapid
            ? [null, null, null, null]
            : await Promise.all([
                buildSearchContext({
                  content: prepared.content,
                  llm,
                  history: prepared.history,
                  send,
                  timeRange: body.timeRange,
                  locale,
                }).catch((err) => {
                  logger.error("chat", "buildSearchContext failed", { error: err instanceof Error ? err.message : String(err) });
                  return null;
                }),
                buildUrlContext({
                  content: prepared.content,
                  send,
                  locale,
                }).catch((err) => {
                  logger.error("chat", "buildUrlContext failed", { error: err instanceof Error ? err.message : String(err) });
                  return null;
                }),
                buildMemoryContext({
                  content: prepared.content,
                  thread,
                  userId: user.id,
                  currentThreadId: thread.id,
                }).catch((err) => {
                  logger.error("chat", "buildMemoryContext failed", { error: err instanceof Error ? err.message : String(err) });
                  return null;
                }),
                buildSkillContext({
                  content: prepared.content,
                  userId: user.id,
                  threadId: thread.id,
                }).catch((err) => {
                  logger.error("chat", "buildSkillContext failed", { error: err instanceof Error ? err.message : String(err) });
                  return null;
                }),
              ]);

        // MCP server connections: connect to servers enabled on the thread and fetch tools.
        // On failure, skip and continue chat (non-blocking).
        // Lifecycle is contained within the request, closed in finally.
        mcpConnections = [];
        let mcpTools: McpTool[] = [];
        const activeMcpServerIds = thread.mcpServerIds ?? [];
        if (activeMcpServerIds.length > 0) {
          try {
            const serverConfigs = await db
              .select({
                id: mcpServers.id,
                name: mcpServers.name,
                transport: mcpServers.transport,
                url: mcpServers.url,
                command: mcpServers.command,
                args: mcpServers.args,
                env: mcpServers.env,
              })
              .from(mcpServers)
              .where(and(eq(mcpServers.userId, user.id), inArray(mcpServers.id, activeMcpServerIds)));
            for (const config of serverConfigs) {
              const conn = await connectMcpServer(config);
              if (conn) {
                mcpConnections.push(conn);
                const tools = await listMcpTools(conn);
                mcpTools.push(...tools);
              }
            }
          } catch (err) {
            logger.error("mcp", "failed to load MCP servers", { error: err instanceof Error ? err.message : String(err) });
          }
        }

        // Load connections: fetch tools for connections enabled on the thread.
        // Unlike MCP, these are stateless HTTP APIs requiring no connection handle.
        // On failure, skip and continue chat (non-blocking).
        const activeConnectionIds = thread.connectionIds ?? [];
        let connectionRows: ConnectionRow[] = [];
        let connectionTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
        if (activeConnectionIds.length > 0) {
          try {
            connectionRows = await loadConnections(user.id, activeConnectionIds);
            for (const conn of connectionRows) {
              connectionTools.push(...getConnectionTools(conn));
            }
          } catch (err) {
            logger.error("connections", "failed to load connections", { error: err instanceof Error ? err.message : String(err) });
          }
        }

        const finalMessages = buildFinalMessages({
          systemContent,
          personalizationContent,
          history: prepared.history,
          content: prepared.content,
          searchContextMessage,
          urlContextMessage,
          skillMessage,
          memoryMessage,
        });

        if (thread.responseMode === "dual") {
          send("status", { label: t(locale, "chat.statusDualPreparing") });
          const dual = await runDualModelFlow({
            llm,
            baseMessages: finalMessages,
            finalModel,
            thread,
            send,
            locale,
          });
          dualTrace = dual.trace;
          send("dual_trace", { dualTrace });
          await streamCompletion({
            llm,
            model: finalModel,
            messages: dual.finalMessages,
            onDelta: (delta) => {
              assistantContent += delta;
              send("delta", { delta });
            },
            onReasoning: (delta) => {
              assistantReasoning += delta;
              send("thinking", { delta });
            },
            timeRange: body.timeRange,
            locale,
          });
        } else {
          if (body.rapid) {
            // rapid mode: skip tool probe, MCP, and connection tools,
            // performing only pure LLM immediate response.
            await streamCompletion({
              llm,
              model: finalModel,
              messages: finalMessages,
              onDelta: (delta) => {
                assistantContent += delta;
                send("delta", { delta });
              },
              onReasoning: (delta) => {
                assistantReasoning += delta;
                send("thinking", { delta });
              },
              timeRange: body.timeRange,
              locale,
            });
          } else {
            // Function calling (tool use) probe: determine if the model supports tool use.
            // If supported, autonomously search/scrape during streaming.
            // If unsupported, fall back to the decideSearch router (buildSearchContext).
            // The probe was started early in the POST body (warmupToolProbe + early call).
            // Here we just await the result (overlapped with parallel processing for latency hiding).
            const toolSupport: ToolSupport | null = await toolSupportPromise;
            // In tool-use mode, exclude the pre-search system message:
            // the "search complete, do not re-search" message hinders the LLM's tool call result reference.
            const effectiveMessages = toolSupport?.supported
              ? buildFinalMessages({
                  systemContent,
                  personalizationContent,
                  history: prepared.history,
                  content: prepared.content,
                  searchContextMessage: null,
                  urlContextMessage,
                  skillMessage,
                  memoryMessage,
                })
              : finalMessages;
            await streamCompletion({
              llm,
              model: finalModel,
              messages: effectiveMessages,
              onDelta: (delta) => {
                assistantContent += delta;
                send("delta", { delta });
              },
              onReasoning: (delta) => {
                assistantReasoning += delta;
                send("thinking", { delta });
              },
              toolSupport,
              send,
              extraTools: [...mcpToolsToOpenAIFormat(mcpTools), ...connectionTools],
              mcpConnections,
              timeRange: body.timeRange,
              locale,
            });
          }
        }

        // Workaround for non-tool-supporting models (e.g. GLM-5.2) that output
        // tool-call syntax as text and halt generation there.
        // On detection, remove the syntax and regenerate with a continuation prompt (max 1 time).
        if (hasToolCallMarkup(assistantContent)) {
          send("status", { label: t(locale, "chat.statusRegenerating") });
          assistantContent = sanitizeToolCallMarkup(assistantContent);
          // Replace the client's displayed content with the sanitized version.
          // Removes tool-call markup emitted during streaming from the UI.
          send("replace_content", { content: assistantContent });
          const continuationMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            ...finalMessages,
            { role: "assistant" as const, content: assistantContent },
            {
              role: "user" as const,
              content:
                "The previous response contained tool-call syntax which is not supported in this environment. " +
                "Web search results have already been provided above — use them to answer directly. " +
                "Do not output any tool-call, function-call, or XML-tag syntax. " +
                "Answer the user's question now.",
            },
          ];

          await streamCompletion({
            llm,
            model: finalModel,
            messages: continuationMessages,
            onDelta: (delta) => {
              assistantContent += delta;
              send("delta", { delta });
            },
            onReasoning: (delta) => {
              assistantReasoning += delta;
              send("thinking", { delta });
            },
            timeRange: body.timeRange,
            locale,
          });
        }
        const elapsedMs = Date.now() - streamStartedAt;
        const [assistantMsg] = await db
          .insert(messages)
          .values({
            threadId: body.threadId,
            parentId: prepared.userMessage.id,
            role: "assistant",
            content: assistantContent,
            reasoning: assistantReasoning || null,
            metadata: dualTrace
              ? { dualTrace, model: finalModel, elapsedMs }
              : { model: finalModel, elapsedMs },
          })
          .returning();

        await db
          .update(threads)
          .set({ currentLeafId: assistantMsg.id, updatedAt: new Date() })
          .where(eq(threads.id, body.threadId));

        send("done", { assistantMessageId: assistantMsg.id, model: finalModel, elapsedMs });
      } catch (err) {
        if (assistantContent) {
          const [partial] = await db
            .insert(messages)
            .values({
              threadId: body.threadId,
              parentId: prepared.userMessage.id,
              role: "assistant",
              content: assistantContent,
              reasoning: assistantReasoning || null,
              metadata: dualTrace ? { dualTrace } : null,
            })
            .returning();
          await db
            .update(threads)
            .set({ currentLeafId: partial.id, updatedAt: new Date() })
            .where(eq(threads.id, body.threadId));
        }
        send("error", { message: err instanceof Error ? err.message : t(locale, "chat.streamError") });
        logger.error("chat", "stream-error", { threadId: body.threadId, error: err instanceof Error ? err.message : String(err) });
      } finally {
        await db
          .update(threads)
          .set({ updatedAt: new Date() })
          .where(eq(threads.id, body.threadId));

        // Pass stream completion content to the after() callback.
        streamResult.assistantContent = assistantContent;

        // Close MCP connections (including stdio child process termination).
        for (const conn of mcpConnections) {
          try { await conn.client.close(); } catch { /* ignore close errors */ }
        }

        // Close the stream immediately (lower client's isStreaming).
        logger.info("chat", "stream-complete", { threadId: body.threadId, duration: Date.now() - streamStartedAt, contentLength: assistantContent.length });
        controller.close();

        // Notify the after() callback of completion.
        resolveStream();
      }
    },
  });

  // Memory generation: run in the background via after() after HTTP response completes.
  // after() must be called within the request context (POST body).
  // Calling it inside ReadableStream's start() loses the request context,
  // so waitUntil doesn't work and the callback never executes.
  // Since we close after sending "done", client UX is not blocked.
  // after() uses Next.js's waitUntil, so the process persists after close.
  // Errors are swallowed (stream already complete, log only).
  after(async () => {
    await streamDone;
    if (!streamResult.assistantContent) return;
    // Rapid mode: skip memory and skill generation, exit immediately.
    if (body.rapid) return;
    try {
      await generateMemories(
        body.threadId,
        [
          { role: "user", content: prepared.content },
          { role: "assistant", content: streamResult.assistantContent },
        ],
        llm,
        finalModel,
        user.id,
      );
    } catch (err) {
      logger.error("memory", "generation failed", { error: err instanceof Error ? err.message : String(err) });
    }

    // Skill save trigger detection: user requests "save as skill" etc.
    if (/(スキルで保存|スキルとして保存|save\s+as\s+skill)/i.test(prepared.content)) {
      try {
        await generateSkillFromConversation(body.threadId, user.id, llm, finalModel);
      } catch (err) {
        logger.error("skill", "generation failed", { error: err instanceof Error ? err.message : String(err) });
      }
    } else {
      // Auto-extract skill candidates: when no explicit save request, extract candidates from the conversation.
      // Heuristic: only run when user+assistant content totals over 200 chars,
      // or contains code/error/config keywords.
      const totalLen = prepared.content.length + streamResult.assistantContent.length;
      const hasSubstantiveContent =
        totalLen > 200 ||
        /```|error|exception|config|bug|fix|debug/i.test(
          prepared.content + streamResult.assistantContent,
        );
      if (hasSubstantiveContent) {
        try {
          await extractSkillCandidates(body.threadId, user.id, llm, finalModel);
        } catch (err) {
          logger.error("skill-candidate", "extraction failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

async function prepareTurn(
  body: Body,
  mode: "send" | "regenerate" | "edit",
  thread: typeof threads.$inferSelect,
  allMessages: DbMessage[],
): Promise<
  | { content: string; userMessage: DbMessage; history: DbMessage[] }
  | { error: string; status: number }
> {
  if (mode === "regenerate") {
    if (!body.parentMessageId) return { error: "parentMessageId is required", status: 400 };
    const userMessage = allMessages.find((m) => m.id === body.parentMessageId);
    if (!userMessage || userMessage.role !== "user") return { error: "user message not found", status: 404 };
    return {
      content: userMessage.content,
      userMessage,
      history: buildChain(allMessages, userMessage.parentId),
    };
  }

  const content = body.content?.trim();
  if (!content) return { error: "content is required", status: 400 };
  if (mode === "edit" && !body.parentMessageId) {
    return { error: "parentMessageId is required", status: 400 };
  }

  const parentId =
    mode === "edit"
      ? allMessages.find((m) => m.id === body.parentMessageId && m.role === "user")?.parentId
      : thread.currentLeafId;

  if (mode === "edit" && body.parentMessageId && parentId === undefined) {
    return { error: "parent message not found", status: 404 };
  }

  const [userMsg] = await db
    .insert(messages)
    .values({ threadId: body.threadId, parentId: parentId ?? null, role: "user", content })
    .returning();

  const history = buildChain(allMessages, parentId ?? null);
  if (thread.title === "New chat" && history.length === 0) {
    const title = content.slice(0, 40) + (content.length > 40 ? "…" : "");
    await db
      .update(threads)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(threads.id, body.threadId)));
  }

  return {
    content,
    userMessage: { id: userMsg.id, parentId: userMsg.parentId, role: "user", content },
    history,
  };
}

function buildChain(allMessages: DbMessage[], leafId: string | null): DbMessage[] {
  const byId = new Map(allMessages.map((m) => [m.id, m]));
  const chain: DbMessage[] = [];
  let currentId = leafId;
  while (currentId) {
    const msg = byId.get(currentId);
    if (!msg) break;
    chain.unshift(msg);
    currentId = msg.parentId;
  }
  return chain;
}

/**
 * Scrape URLs contained in the user's message and inject them as context.
 *
 * - Extract URLs via extractUrls (max 10, deduplicated)
 * - Scrape each URL in parallel via scrapeUrl (one failure doesn't stop others: Promise.allSettled)
 * - Build a system message from successful results
 * - All failures / 0 results → null (do nothing)
 * - SSE progress: status → sources
 */
async function buildUrlContext({
  content,
  send,
  locale,
}: {
  content: string;
  send: StreamSend;
  locale: Locale;
}): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam | null> {
  const urls = extractUrls(content);
  if (urls.length === 0) return null;

  if (urls.length >= 10) {
    send("status", { label: t(locale, "chat.statusUrlFetchFirst") });
  } else {
    send("status", { label: t(locale, "chat.statusUrlFetch") });
  }

  const settled = await Promise.allSettled(urls.map((u) => scrapeUrl(u)));

  const sources: SourceInfo[] = [];
  const blocks: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const r = settled[i];
    if (r.status !== "fulfilled" || r.value === null) continue;
    const result = r.value;
    sources.push({
      url: result.url,
      title: result.title,
      snippet: result.content.slice(0, 200),
    });
    blocks.push(
      `<${result.url}>\n${result.title}\n${result.content.slice(0, SEARCH_RESULT_CONTENT_SLICE)}`,
    );
  }

  if (sources.length > 0) send("sources", { sources });
  if (blocks.length === 0) return null;

  return {
    role: "system",
    content: `URL content (use these to answer):\n${blocks.join("\n\n")}`,
  };
}

async function buildSearchContext({
  content,
  llm,
  history,
  send,
  timeRange,
  locale,
}: {
  content: string;
  llm: OpenAI;
  history: DbMessage[];
  send: StreamSend;
  timeRange?: "day" | "week" | "month" | "year";
  locale: Locale;
}): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam | null> {
  const tTotal = Date.now();
  const searchModel = defaultSearchModel();
  const tDecide = Date.now();
  const decision = await decideSearch(
    content,
    searchModel,
    locale,
    history
      .slice(-6)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content })),
  );
  logger.info("search-timing", "decideSearch", { duration: Date.now() - tDecide, searchLevel: decision.searchLevel, queries: decision.queries.length });

  if (decision.searchLevel === "none" || decision.queries.length === 0) {
    logger.info("search-timing", "buildSearchContext total", { duration: Date.now() - tTotal, result: "no search" });
    return null;
  }

  // wiki level: lightweight lookup via Wikipedia REST API (no SearXNG/scraper).
  // If no article is found, answer from training data (does not fall back to full web search).
  if (decision.searchLevel === "wiki") {
    const tWiki = Date.now();
    const wikiResults = await Promise.all(
      decision.queries.slice(0, 2).map((q) => searchWikipedia(q).catch(() => null)),
    );
    const valid = wikiResults.filter((r): r is WikipediaResult => r !== null);
    logger.info("search-timing", "wikipedia lookup", { duration: Date.now() - tWiki, found: valid.length });
    if (valid.length === 0) {
      send("status", { label: t(locale, "chat.statusWikiMiss") });
      logger.info("search-timing", "buildSearchContext total", { duration: Date.now() - tTotal, result: "wiki miss" });
      return {
        role: "system",
        content: "Wikipedia lookup was attempted but no article was found. Answer from your training data and acknowledge the limitation.",
      };
    }
    send("sources", { sources: valid.map((r) => ({ url: r.url, title: r.title, snippet: r.description })) });
    const contextContent = valid
      .map((r) => `Title: ${r.title}\nDescription: ${r.description}\nURL: ${r.url}\nExtract: ${r.extract}`)
      .join("\n\n");
    logger.info("search-timing", "buildSearchContext total", { duration: Date.now() - tTotal, result: "wiki hit" });
    return {
      role: "system",
      content: `Wikipedia lookup has been completed. Use this to answer the user's question directly. Do NOT attempt to search or scrape again.\n\nWikipedia results:\n${contextContent}`,
    };
  }


  send("status", { label: decision.userNotice ?? t(locale, "chat.statusSearchFallback") });

  const maxResults = Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3;
  const maxRounds = Math.min(5, Math.max(1, Number(process.env.WEB_SEARCH_MAX_ROUNDS) || 1));
  const allSources: SourceInfo[] = [];
  const allResults: { url: string; title: string; snippet: string; content: string }[] = [];

  const queries = decision.queries.slice(0, maxRounds);
  // Execute queries in parallel to reduce latency (serial would take up to maxRounds times longer)
  const tParallel = Date.now();
  const queryResults = await Promise.all(
    queries.map(async (query, qi) => {
      const tQuery = Date.now();
      try {
        const response = await searchWeb(query, maxResults, timeRange);
        logger.info("search-timing", "query", { index: qi + 1, total: queries.length, duration: Date.now() - tQuery, results: response.results.length });
        return response;
      } catch {
        logger.info("search-timing", "query", { index: qi + 1, total: queries.length, duration: Date.now() - tQuery, results: 0, error: true });
        return null;
      }
    }),
  );
  logger.info("search-timing", "all queries parallel", { duration: Date.now() - tParallel, count: queries.length });
  for (const response of queryResults) {
    if (!response) continue;
    for (const r of response.results.slice(0, maxResults)) {
      allSources.push({ url: r.url, title: r.scrapeTitle || r.title, snippet: r.snippet });
      allResults.push({
        url: r.url,
        title: r.scrapeTitle || r.title,
        snippet: r.snippet,
        content: r.scraped
          ? r.content.slice(0, SEARCH_RESULT_CONTENT_SLICE)
          : r.raw_content || r.snippet,
      });
    }
  }

  if (allSources.length > 0) send("sources", { sources: allSources });
  if (allResults.length === 0) {
    send("status", { label: t(locale, "chat.statusWebEmpty") });
    // This message only reaches non-tool-supporting models (tool-supporting models
    // have searchContextMessage excluded in effectiveMessages and search autonomously).
    // Communicate the search failure and have the model answer from training data,
    // making it explicit that information could not be retrieved.
    // Returning null would be treated as search not executed, also losing failure awareness.
    logger.info("search-timing", "buildSearchContext total", { duration: Date.now() - tTotal, result: "no results" });
    return {
      role: "system",
      content: "Web search was attempted but returned no results. Answer from your training data and acknowledge that you could not retrieve current information.",
    };
  }
  // Summarization step is deprecated: raw search results are embedded directly into the system message.
  // Each result's content is sliced by SEARCH_RESULT_CONTENT_SLICE, so even raw JSON is short enough.
  const tSummarize = Date.now();
  const contextContent = JSON.stringify(allResults, null, 2);
  logger.info("search-timing", "skip-summarize", { duration: Date.now() - tSummarize, chars: contextContent.length });

  logger.info("search-timing", "buildSearchContext total", { duration: Date.now() - tTotal });
  return {
    role: "system",
    content: `Web search has already been completed. The results are provided below. Do NOT attempt to search or scrape again — do not output any tool-call commands. Answer the user's question directly using only these results.\n\nWeb search results:\n${contextContent}`,
  };
}
/**
 * Build environment context (current date/time + execution environment) to inject at the prompt head.
 *
 * - Uses HOST_OS env if set (overridable via GUI)
 * - If unset, auto-detects host OS from /proc/version:
 *   - Contains "microsoft" or "WSL" → "Windows" (Docker Desktop on WSL2)
 *   - Contains "Darwin" → "macOS"
 *   - Otherwise → "Linux"
 * - Architecture from process.arch (x64 / arm64 etc.)
 * - Timezone from TZ env (defaults to Asia/Tokyo if unset)
 */
function getEnvContext(): string {
  const os = process.env.HOST_OS || detectHostOs();
  const arch = process.arch;
  const tz = process.env.TZ || "Asia/Tokyo";
  const now = new Date().toLocaleString("sv-SE", { timeZone: tz });
  return `Current date: ${now}\nEnvironment: ${os} (${arch})`;
}

let detectedHostOs: string | null = null;

function detectHostOs(): string {
  if (detectedHostOs !== null) return detectedHostOs;
  let result = "Linux";
  try {
    const version = readFileSync("/proc/version", "utf8");
    if (/microsoft|WSL/i.test(version)) result = "Windows";
    else if (/Darwin/i.test(version)) result = "macOS";
  } catch {
    result = "Linux";
  }
  detectedHostOs = result;
  return result;
}

function buildFinalMessages({
  systemContent,
  personalizationContent,
  history,
  content,
  searchContextMessage,
  urlContextMessage,
  skillMessage,
  memoryMessage,
}: {
  systemContent?: string | null;
  personalizationContent?: string | null;
  history: DbMessage[];
  content: string;
  searchContextMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam | null;
  urlContextMessage?: OpenAI.Chat.Completions.ChatCompletionMessageParam | null;
  skillMessage?: { role: "system"; content: string } | null;
  memoryMessage?: { role: "system"; content: string } | null;
}): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    { role: "system" as const, content: getEnvContext() },
    ...(personalizationContent ? [{ role: "system" as const, content: personalizationContent }] : []),
    ...(systemContent ? [{ role: "system" as const, content: systemContent }] : []),
    ...(skillMessage ? [skillMessage] : []),
    ...(memoryMessage ? [memoryMessage] : []),
    ...history.map(
      (m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam,
    ),
    ...(searchContextMessage ? [searchContextMessage] : []),
    ...(urlContextMessage ? [urlContextMessage] : []),
    { role: "user" as const, content },
  ];
}

async function runDualModelFlow({
  llm,
  baseMessages,
  finalModel,
  thread,
  send,
  locale,
}: {
  llm: OpenAI;
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  finalModel: string;
  thread: typeof threads.$inferSelect;
  send: StreamSend;
  locale: Locale;
}): Promise<{ trace: DualTrace; finalMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] }> {
  const { modelA, modelB } = await resolveDualModels(thread, finalModel);

  send("status", { label: t(locale, "chat.statusDualModelA", { model: modelA }) });
  const answerA = await completeText(llm, modelA, withDualInstruction(baseMessages, "You are model A. Give your best independent answer."));

  send("status", { label: t(locale, "chat.statusDualModelB", { model: modelB }) });
  const answerB = await completeText(llm, modelB, withDualInstruction(baseMessages, "You are model B. Give your best independent answer."));
  if (thread.dualStrategy === "debate") {
    const debateTurns = await runDebateTurns({ llm, baseMessages, modelA, modelB, answerA, answerB, rounds: thread.dualDebateRounds, send, locale });
    const trace: DualTrace = {
      strategy: "debate",
      modelA,
      modelB,
      finalModel,
      answerA,
      answerB,
      debateTurns,
    };
    return { trace, finalMessages: buildSynthesisMessages(baseMessages, trace) };
  }

  send("status", { label: t(locale, "chat.statusReviewA") });
  const reviewA = await completeText(llm, modelA, [
    ...baseMessages,
    { role: "assistant", content: `Model A answer:\n${answerA}` },
    { role: "assistant", content: `Model B answer:\n${answerB}` },
    { role: "user", content: "Review Model B's answer. Identify strengths, gaps, and corrections. Be concise." },
  ]);

  send("status", { label: t(locale, "chat.statusReviewB") });
  const reviewB = await completeText(llm, modelB, [
    ...baseMessages,
    { role: "assistant", content: `Model A answer:\n${answerA}` },
    { role: "assistant", content: `Model B answer:\n${answerB}` },
    { role: "user", content: "Review Model A's answer. Identify strengths, gaps, and corrections. Be concise." },
  ]);
  const trace: DualTrace = {
    strategy: "cross_review",
    modelA,
    modelB,
    finalModel,
    answerA,
    answerB,
    reviewA,
    reviewB,
  };
  return { trace, finalMessages: buildSynthesisMessages(baseMessages, trace) };
}

async function resolveDualModels(thread: typeof threads.$inferSelect, finalModel: string): Promise<{ modelA: string; modelB: string }> {
  const modelA = thread.dualModelA || finalModel;
  if (thread.dualModelB) return { modelA, modelB: thread.dualModelB };

  const models = await availableModels();
  return { modelA, modelB: models.find((m) => m !== modelA) ?? modelA };
}

function withDualInstruction(
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  instruction: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    ...baseMessages,
    {
      role: "system",
      content: `${instruction}\nDo not mention that another model will review you. Answer the user directly.`,
    },
  ];
}

async function runDebateTurns({
  llm,
  baseMessages,
  modelA,
  modelB,
  answerA,
  answerB,
  rounds,
  send,
  locale,
}: {
  llm: OpenAI;
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  modelA: string;
  modelB: string;
  answerA: string;
  answerB: string;
  rounds: number;
  send: StreamSend;
  locale: Locale;
}): Promise<{ speaker: "A" | "B"; model: string; content: string }[]> {
  const debateTurns: { speaker: "A" | "B"; model: string; content: string }[] = [];
  const clampedRounds = Math.min(5, Math.max(1, Math.trunc(rounds || 2)));

  for (let round = 1; round <= clampedRounds; round++) {
    send("status", { label: t(locale, "chat.statusDebateRound", { round: String(round), total: String(clampedRounds) }) });
    const transcript = formatDebateTranscript(answerA, answerB, debateTurns);
    const speakerA = await completeText(llm, modelA, [
      ...baseMessages,
      { role: "assistant", content: transcript },
      { role: "user", content: "As model A, respond to the debate so far with concise corrections or support." },
    ]);
    debateTurns.push({ speaker: "A", model: modelA, content: speakerA });

    const speakerB = await completeText(llm, modelB, [
      ...baseMessages,
      { role: "assistant", content: formatDebateTranscript(answerA, answerB, debateTurns) },
      { role: "user", content: "As model B, respond to the debate so far with concise corrections or support." },
    ]);
    debateTurns.push({ speaker: "B", model: modelB, content: speakerB });
  }

  return debateTurns;
}

function formatDebateTranscript(
  answerA: string,
  answerB: string,
  turns: { speaker: "A" | "B"; model: string; content: string }[],
): string {
  return [
    `Initial answer A:\n${answerA}`,
    `Initial answer B:\n${answerB}`,
    ...turns.map((turn) => `Model ${turn.speaker} (${turn.model}):\n${turn.content}`),
  ].join("\n\n");
}

function buildSynthesisMessages(
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  trace: DualTrace,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    ...baseMessages,
    {
      role: "system",
      content:
        "You are the final synthesizer. Use the dual-model work below to answer the user. " +
        "Do not expose hidden process unless needed; provide the best concise final conclusion.",
    },
    { role: "assistant", content: `Dual-model trace:\n${JSON.stringify(trace, null, 2)}` },
    { role: "user", content: "Give the final answer based on the dual-model trace." },
  ];
}
async function completeText(
  llm: OpenAI,
  model: string,
  messagesForModel: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  options?: { maxTokens?: number; reasoningEffort?: OpenAI.ReasoningEffort | null; disableThinking?: boolean },
): Promise<string> {
  const disableParams = options?.disableThinking ? await buildDisableReasoningParams(model) : {};
  const completion = await llm.chat.completions.create({
    model,
    messages: messagesForModel,
    stream: false,
    ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    ...disableParams,
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
  return completion.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Tool definitions for streaming completion.
 * Used only when probeToolSupport returns supported:true.
 */
const STREAM_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "scrape_webpage",
      description:
        "Fetch and read the content of a web page at the given URL. Use when the user shares a URL or when you need to read a specific web page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to scrape" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Search the web for current information or unfamiliar terms. Use when you need facts you are not confident about.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_wikipedia",
      description: "Look up a Wikipedia article for a concept, person, place, or term. Use this for factual information about named entities when you don't need real-time data. Faster than search_web.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (entity name or term)" },
        },
        required: ["query"],
      },
    },
  },
];

const MAX_TOOL_ROUNDS = 3;

async function streamCompletion({
  llm,
  model,
  messages: messagesForModel,
  onDelta,
  onReasoning,
  toolSupport,
  send,
  extraTools,
  mcpConnections,
  connectionRows,
  timeRange,
  locale,
}: {
  llm: OpenAI;
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  onDelta: (delta: string) => void;
  onReasoning: (delta: string) => void;
  toolSupport?: ToolSupport | null;
  send?: StreamSend;
  extraTools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  mcpConnections?: McpConnection[];
  connectionRows?: ConnectionRow[];
  timeRange?: "day" | "week" | "month" | "year";
  locale: Locale;
}) {
  const llmStreamStartedAt = Date.now();
  logger.info("chat", "llm-stream-start", { model });
  const thinkingEffort = process.env.THINKING_EFFORT;
  const validLevels = await getReasoningLevels(model);
  const reasoningEffort =
    thinkingEffort && validLevels.includes(thinkingEffort)
      ? thinkingEffort
      : await getDefaultReasoningEffort(model);
  const disableReasoningParams = await buildDisableReasoningParams(model);

  const useTools = toolSupport?.supported === true && send !== undefined;
  const searchMaxResults = Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3;

  let currentMessages = messagesForModel;
  let rounds = 0;

  // Tool-use mode: when tool_calls are detected during streaming,
  // execute the tools, append results as tool role messages, and re-stream.
  // Up to MAX_TOOL_ROUNDS times. Beyond that, continue answering without tools.
  while (true) {
    const useToolsThisRound = useTools && rounds < MAX_TOOL_ROUNDS;

    const completion = await llm.chat.completions.create({
      model,
      messages: currentMessages,
      stream: true,
      ...(useToolsThisRound
        ? disableReasoningParams
        : reasoningEffort
          ? { reasoning_effort: reasoningEffort }
          : {}),
      ...(useToolsThisRound
        ? { tools: [...STREAM_TOOLS, ...(extraTools ?? [])], tool_choice: "auto" }
        : {}),
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

    // Accumulate tool_calls deltas during streaming.
    // In OpenAI's streaming format, tool_calls arrive split across chunks,
    // so we join them by index.
    const toolCallAccumulator: Record<
      number,
      { id: string; name: string; arguments: string }
    > = {};
    let hadToolCalls = false;

    for await (const chunk of completion) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const reasoningDelta = (
        choice.delta as Record<string, unknown> as { reasoning_content?: string }
      ).reasoning_content;
      if (reasoningDelta) onReasoning(reasoningDelta);
      const contentDelta = choice.delta?.content;
      if (contentDelta) onDelta(contentDelta);

      // Accumulate tool_calls delta
      const deltaToolCalls = (
        choice.delta as Record<string, unknown> as {
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        }
      ).tool_calls;
      if (deltaToolCalls) {
        hadToolCalls = true;
        for (const tc of deltaToolCalls) {
          const existing = toolCallAccumulator[tc.index] ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCallAccumulator[tc.index] = existing;
        }
      }
    }

    if (!hadToolCalls || !useToolsThisRound) {
      // No tool calls, or max rounds exceeded → done
      break;
    }

    rounds++;

    // Execute tool calls
    const toolCalls = Object.values(toolCallAccumulator).filter((tc) => tc.name);

    // Add assistant message (including tool_calls) to history
    currentMessages = [
      ...currentMessages,
      {
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam,
    ];

    const sources: SourceInfo[] = [];

    // Execute each tool call and append the result as a tool role message
    for (const tc of toolCalls) {
      let toolContent: string;
      let parsedArgs: { url?: string; query?: string };
      try {
        parsedArgs = JSON.parse(tc.arguments) as { url?: string; query?: string };
      } catch {
        parsedArgs = {};
      }

      if (tc.name === "scrape_webpage" && parsedArgs.url) {
        send?.("status", { label: t(locale, "chat.statusToolScrape") });
        const tTool = Date.now();
        try {
        const result = await scrapeUrl(parsedArgs.url);
        if (result === null) {
          toolContent = `Failed to scrape ${parsedArgs.url}`;
        } else {
          sources.push({
            url: result.url,
            title: result.title,
            snippet: result.content.slice(0, 200),
          });
          toolContent = `<${result.url}>\n${result.title}\n${result.content.slice(0, SEARCH_RESULT_CONTENT_SLICE)}`;
        }
        } catch {
          toolContent = `Failed to scrape ${parsedArgs.url}`;
        }
        logger.info("search-timing", "tool", { tool: "scrape_webpage", round: rounds, duration: Date.now() - tTool });
      } else if (tc.name === "search_web" && parsedArgs.query) {
        send?.("status", { label: t(locale, "chat.statusToolSearch") });
        const tTool = Date.now();
        try {
          const response = await searchWeb(parsedArgs.query, searchMaxResults, timeRange);
          for (const r of response.results) {
            sources.push({
              url: r.url,
              title: r.scrapeTitle || r.title,
              snippet: r.snippet,
            });
          }
          toolContent = response.results
            .map(
              (r) =>
                `<${r.url}>\n${r.scrapeTitle || r.title}\n${r.scraped ? r.content.slice(0, SEARCH_RESULT_CONTENT_SLICE) : r.snippet}`,
            )
            .join("\n\n");
          if (!toolContent) toolContent = "No results found.";
        } catch {
          toolContent = `Search failed for: ${parsedArgs.query}`;
        }
        logger.info("search-timing", "tool", { tool: "search_web", round: rounds, duration: Date.now() - tTool });
      } else if (tc.name === "search_wikipedia" && parsedArgs.query) {
        send?.("status", { label: t(locale, "chat.statusWikiLooking") });
        const tTool = Date.now();
        try {
          const result = await searchWikipedia(parsedArgs.query);
          if (result) {
            sources.push({ url: result.url, title: result.title, snippet: result.description });
            toolContent = `<${result.url}>\n${result.title}\n${result.description}\n${result.extract}`;
          } else {
            toolContent = "No Wikipedia article found.";
          }
        } catch {
          toolContent = `Wikipedia lookup failed for: ${parsedArgs.query}`;
        }
        logger.info("search-timing", "tool", { tool: "search_wikipedia", round: rounds, duration: Date.now() - tTool });
      } else if (tc.name.includes("__") && mcpConnections && mcpConnections.length > 0) {
        // MCP tool: function name format "{serverName}__{toolName}"
        const parsed = parseMcpToolFunctionName(tc.name);
        if (parsed) {
          const conn = mcpConnections.find((c) => c.serverName === parsed.serverName);
          if (conn) {
            send?.("status", { label: t(locale, "chat.statusToolMcp", { server: parsed.serverName, tool: parsed.toolName }) });
            try {
              let mcpArgs: Record<string, unknown>;
              try {
                mcpArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
              } catch {
                mcpArgs = {};
              }
              toolContent = await callMcpTool(conn, parsed.toolName, mcpArgs);
            } catch {
              toolContent = `MCP tool ${tc.name} failed`;
            }
          } else {
            toolContent = `MCP server "${parsed.serverName}" not connected`;
          }
        } else {
          toolContent = `Unknown tool: ${tc.name}`;
        }
      } else if (tc.name.startsWith("notion_") && connectionRows && connectionRows.length > 0) {
        // Connection tool: identify provider by "notion_" prefix.
        // Notion is currently the only provider, so use the first matching connection.
        const conn = connectionRows[0];
        send?.("status", { label: t(locale, "chat.statusToolNotion", { tool: tc.name }) });
        try {
          let connArgs: Record<string, unknown>;
          try {
            connArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
          } catch {
            connArgs = {};
          }
          const result = await dispatchConnectionTool(conn, tc.name, connArgs);
          toolContent = result.content;
          // Persist refreshed token to DB if present
          if (result.newAccessToken && result.newRefreshToken) {
            try {
              await db.update(connections)
                .set({ accessToken: result.newAccessToken, refreshToken: result.newRefreshToken, updatedAt: new Date() })
                .where(eq(connections.id, conn.id));
            } catch {
              // Ignore persistence errors — will be refreshed again on next call
            }
          }
        } catch {
          toolContent = `Connection tool ${tc.name} failed`;
        }
      } else {
        toolContent = `Unknown tool: ${tc.name}`;
      }

      currentMessages = [
        ...currentMessages,
        {
          role: "tool",
          tool_call_id: tc.id,
          content: toolContent,
        } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam,
      ];
    }

    if (sources.length > 0) send?.("sources", { sources });

    if (rounds >= MAX_TOOL_ROUNDS) {
      send?.("status", { label: t(locale, "chat.statusSearchLimit") });
    }

    // Re-stream (next round)
  }
  logger.info("chat", "llm-stream-end", { model, duration: Date.now() - llmStreamStartedAt });
}
