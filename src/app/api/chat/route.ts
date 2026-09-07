import { and, asc, eq, inArray } from "drizzle-orm";
import type OpenAI from "openai";
import { createLLM, defaultModel, defaultSearchModel, searchThinkingEffort, getReasoningLevels, getDefaultReasoningEffort, availableModels, buildDisableReasoningParams, extractUpstreamDetail, fallbackModel, fallbackTimeoutMs, llmBaseUrl, llmProvider } from "@/lib/llm";
import { buildCursorPrompt, runCursorChat } from "@/lib/cursorLlm";
import { db } from "@/db";
import { messages, threads, users, mcpServers, connections, globalInstructions, folders } from "@/db/schema";
import { getRequestLocale, t } from "@/lib/i18n";
import { createTodo, listTodos, updateTodo, deleteTodo } from "@/lib/todoStore";
import type { Locale } from "@/lib/i18n/types";
import { scrapeUrl, searchWeb, detectSearchLanguage, dedupeAndRankSearchResults } from "@/lib/scraper";
import type { SourceInfo } from "@/lib/scraper";
import { extractUrls } from "@/lib/urlExtract";
import { decideSearch, type SearchQuery } from "@/lib/searchDecision";
import {
  applyDomainQualityFilter,
  formatSearchResultsForContext,
  isThinSearchResults,
  rewriteQueryForRetry,
  sliceContentAroundQuery,
} from "@/lib/searchQuality";
import { searchWikipedia } from "@/lib/wikipedia";
import type { WikipediaResult } from "@/lib/wikipedia";
import { probeToolSupport, warmupToolProbe } from "@/lib/toolProbe";
import type { ToolSupport } from "@/lib/toolProbe";
import { buildSkillContext, attachUsageMessageIds, listSkills, createSkill, deleteSkill, updateSkillContent, type InjectedSkillInfo } from "@/lib/skillStore";
import { buildMemoryContext } from "@/lib/memoryStore";
import {
  buildKnowledgeContextMessage,
  createKnowledgeBase,
  createKnowledgeBaseFromJsonl,
  deleteKnowledgeBase,
  listKnowledgeBases,
  ingestDocument,
  ingestFolder,
  ingestJsonlFile,
  searchKnowledgeBases,
} from "@/lib/kbStore";
import { buildJsonlFilterFromToolArgs } from "@/lib/jsonlFilter";
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
  resolveProviderFromToolName,
  type ConnectionRow,
} from "@/lib/connections";
import { hasToolCallMarkup, sanitizeToolCallMarkup } from "@/lib/toolCallSanitizer";
import { buildPersonalizationMessage } from "@/lib/personalization";
import { appendChatExport } from "@/lib/chatExport";
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  listWorkspaceDirectory,
  runWorkspaceCommand,
  searchWorkspaceFiles,
  grepWorkspaceContent,
} from "@/lib/workspace";
import { editFileInWorkspace } from "@/lib/editFile";
import { createLoopGuardState, precheckToolCalls, recordToolOutcome } from "@/lib/toolLoopGuard";
import {
  resolveBufferedToolRoundContent,
  TOOL_GROUNDING_REMINDER,
} from "@/lib/toolStreamPolicy";
import {
  recordToolResult,
  shouldForceFinalAnswer,
  buildForcedReportPrompt,
  formatAutoUserReport,
  type ToolTranscriptEntry,
} from "@/lib/agentHooks";
import {
  formatToolOutcomeForModel,
  outcomeOk,
  outcomeEmpty,
  outcomeError,
  outcomeBlocked,
  type ToolOutcome,
} from "@/lib/toolOutcome";
import {
  agentContinueRetriesFromEnv,
  agentContinueMinCharsFromEnv,
  buildContinueAgentPrompt,
  decideContinueToolLoop,
} from "@/lib/agentContinuePolicy";
import { runSandbox, getSandboxToolsForRequest } from "@/lib/sandbox";
import { logger } from "@/lib/logger";
import { readProcessLogs } from "@/lib/logReader";

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
type HyperTrace = {
  rounds: {
    perspective: string;
    draft: string;
    critique: string;
    revised: string;
  }[];
  finalModel: string;
};

type CouncilPanel = {
  id: string;
  persona: string;
  model: string;
};

type CouncilTrace = {
  panels: CouncilPanel[];
  initialAnswers: { panelId: string; content: string }[];
  discussionTurns: { panelId: string; round: number; content: string }[];
  finalModel: string;
  roundsCompleted: number;
  timeLimitReached: boolean;
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
  if (body.content && body.content.length > 102400) return new Response("Content too long (max 100KB)", { status: 413 });

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
  let finalModel = body.model ?? thread.model ?? defaultModel();
  const useCursorProvider = llmProvider() === "cursor";
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
  // Skip when Cursor provider (no OpenAI tool loop) or rapid mode.
  const toolSupportPromise: Promise<ToolSupport | null> =
    body.rapid || useCursorProvider
      ? Promise.resolve(null)
      : probeToolSupport(llm, finalModel).catch(() => null);

  // Promise to wait for stream completion. after() callback runs
  // generateMemories within the request context, so we pass the
  // content after the stream completes.
  let resolveStream!: () => void;
  const streamDone = new Promise<void>((resolve) => {
    resolveStream = resolve;
  });
  const streamResult: { assistantContent: string; assistantMessageId?: string } = { assistantContent: "" };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const streamStartedAt = Date.now();
      const send: StreamSend = (event, data) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Client disconnected (mobile backgrounded, tab closed, network lost).
          // Swallow the error so LLM generation continues to completion
          // and the full/partial response is persisted to DB.
          // The client will re-fetch the thread on return to pick it up.
        }
      };

      let assistantContent = "";
      let assistantReasoning = "";
      let dualTrace: DualTrace | undefined;
      let hyperTrace: HyperTrace | undefined;
      let mcpConnections: McpConnection[] = [];
      let councilTrace: CouncilTrace | undefined;
      let injectedSkills: InjectedSkillInfo[] = [];

      try {
        send("start", { userMessageId: prepared.userMessage.id });
        // Stale-model guard: a provider template switch (e.g. Go → Zen) keeps
        // the old model id, which the new endpoint rejects opaquely. Fail fast
        // before any upstream call so UI/API paths share one checkpoint.
        // Fail-open when the catalog itself is unreachable (single fallback entry).
        if (!useCursorProvider) {
          const catalog = await availableModels().catch(() => null);
          const catalogUnreachable =
            catalog !== null && catalog.length === 1 && catalog[0] === defaultModel() && finalModel !== catalog[0];
          if (catalog !== null && !catalogUnreachable && !catalog.includes(finalModel)) {
            const msg = `Model "${finalModel}" is not available on ${llmBaseUrl()} — カタログから選び直してください。`;
            try { send("error", { message: msg }); } catch { /* client already gone */ }
            logger.error("chat", "stream-error", { threadId: body.threadId, model: finalModel, error: msg });
            return;
          }
        }

        // ── Cursor SDK provider: skip Minerva tools / dual / hyper / council ──
        if (useCursorProvider) {
          const cursorPrompt = buildCursorPrompt({
            systemContent,
            history: prepared.history.map((m) => ({
              role: typeof m.role === "string" ? m.role : "user",
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            })),
            userContent: prepared.content,
          });
          send("status", { label: t(locale, "chat.statusThinking") });
          const cursorResult = await runCursorChat({
            userId: user.id,
            model: finalModel,
            prompt: cursorPrompt,
            existingAgentId: thread.cursorAgentId,
            handlers: {
              onDelta: (delta) => {
                assistantContent += delta;
                send("delta", { delta });
              },
              onReasoning: (delta) => {
                assistantReasoning += delta;
                send("thinking", { delta });
              },
              onStatus: (label) => send("status", { label }),
            },
          });
          if (cursorResult.assistantContent && !assistantContent) {
            assistantContent = cursorResult.assistantContent;
          }
          if (cursorResult.agentId && cursorResult.agentId !== thread.cursorAgentId) {
            await db
              .update(threads)
              .set({ cursorAgentId: cursorResult.agentId, updatedAt: new Date() })
              .where(eq(threads.id, body.threadId));
          }
        } else {
        // Run pre-stream processing in parallel to reduce first-token latency.
        // Each build* is wrapped with .catch(() => null) to isolate failures.
        // rapid mode skips all (null).
        const [searchContextMessage, urlContextMessage, memoryMessage, skillResult, knowledgeMessage] =
          body.rapid
            ? [null, null, null, null, null]
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
                  userMessageId: prepared.userMessage.id,
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
                buildKnowledgeContextMessage(
                  prepared.content,
                  thread.activeKbIds ?? [],
                  user.id,
                ).catch((err) => {
                  logger.error("chat", "buildKnowledgeContextMessage failed", { error: err instanceof Error ? err.message : String(err) });
                  return null;
                }),
              ]);

        const skillMessage = skillResult?.message ?? null;
        injectedSkills = skillResult?.injected ?? [];
        // SSE skills event: send before first token so the client can render
        // chips immediately. Persistent metadata is saved with the assistant row.
        if (injectedSkills.length > 0) {
          send("skills", { skills: injectedSkills });
        }

        // MCP server connections: connect to servers enabled on the thread and fetch tools.
        // On failure, skip and continue chat (non-blocking).
        // Lifecycle is contained within the request, closed in finally.
        mcpConnections = [];
        const mcpTools: McpTool[] = [];
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
                headers: mcpServers.headers,
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
        const connectionTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
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
          knowledgeMessage,
          useTools: false,
        });
        if (thread.responseMode === "council") {
          send("status", { label: t(locale, "chat.statusCouncilPreparing") });
          const council = await runCouncilFlow({
            llm,
            baseMessages: finalMessages,
            finalModel,
            thread,
            send,
            locale,
          });
          councilTrace = council.trace;
          send("council_trace", { councilTrace });
          await streamCompletion({
            llm,
            model: finalModel,
            messages: council.finalMessages,
            onDelta: (delta) => { assistantContent += delta; send("delta", { delta }); },
            onReasoning: (delta) => { assistantReasoning += delta; send("thinking", { delta }); },
            timeRange: body.timeRange,
            locale,
            userId: user.id,
            threadId: body.threadId,
            onModelFallback: (m) => { finalModel = m; },
          });
        } else if (thread.responseMode === "hyper") {
          send("status", { label: t(locale, "chat.statusHyperPreparing") });
          const hyper = await runHyperThinkingFlow({
            llm,
            baseMessages: finalMessages,
            finalModel,
            thread,
            send,
            locale,
          });
          hyperTrace = hyper.trace;
          send("hyper_trace", { hyperTrace });
          await streamCompletion({
            llm,
            model: finalModel,
            messages: hyper.finalMessages,
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
            userId: user.id,
            threadId: body.threadId,
            onModelFallback: (m) => { finalModel = m; },
          });
        } else if (thread.responseMode === "dual") {
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
            userId: user.id,
            threadId: body.threadId,
            onModelFallback: (m) => { finalModel = m; },
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
              send,
              timeRange: body.timeRange,
              locale,
              userId: user.id,
              threadId: body.threadId,
              onModelFallback: (m) => { finalModel = m; },
            });
          } else {
            // Function calling (tool use) probe: determine if the model supports tool use.
            // If supported, autonomously search/scrape during streaming.
            // If unsupported, fall back to the decideSearch router (buildSearchContext).
            // The probe was started early in the POST body (warmupToolProbe + early call).
            // Here we just await the result (overlapped with parallel processing for latency hiding).
            const toolSupport: ToolSupport | null = await toolSupportPromise;
            // Probe sandbox availability (Docker + image) in parallel with the
            // tool-use probe so the sandbox_run tool is only offered when the
            // host can actually serve it. Returns [] when Docker is off.
            const sandboxTools = await getSandboxToolsForRequest().catch(() => []);
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
                  knowledgeMessage,
                  useTools: true,
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
              extraTools: [...mcpToolsToOpenAIFormat(mcpTools), ...connectionTools, ...sandboxTools],
              mcpConnections,
              connectionRows,
              timeRange: body.timeRange,
              locale,
              userId: user.id,
              threadId: body.threadId,
              onModelFallback: (m) => { finalModel = m; },
            });
          }
        }

        // Workaround for non-tool-supporting models (e.g. GLM-5.2) that output
        // tool-call syntax as text and halt generation there.
        // On detection, remove the syntax and regenerate with a continuation prompt (max 1 time).
        if (hasToolCallMarkup(assistantContent)) {
          send("status", { label: t(locale, "chat.statusRegenerating") });
          assistantContent = sanitizeToolCallMarkup(assistantContent);
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
            userId: user.id,
            threadId: body.threadId,
          });
        }
        } // end openai provider branch

        const elapsedMs = Date.now() - streamStartedAt;
        const [assistantMsg] = await db
          .insert(messages)
          .values({
            threadId: body.threadId,
            parentId: prepared.userMessage.id,
            role: "assistant",
            content: assistantContent,
            reasoning: assistantReasoning || null,
            metadata: buildAssistantMetadata({
              finalModel,
              elapsedMs,
              dualTrace,
              hyperTrace,
              councilTrace,
              injectedSkills,
            }),
          })
          .returning();
        streamResult.assistantMessageId = assistantMsg.id;
        if (injectedSkills.length > 0) {
          await attachUsageMessageIds(
            injectedSkills.map((s) => s.usageEventId),
            assistantMsg.id,
            user.id,
          );
        }

        await db
          .update(threads)
          .set({ currentLeafId: assistantMsg.id, updatedAt: new Date() })
          .where(eq(threads.id, body.threadId));

        send("done", { assistantMessageId: assistantMsg.id, model: finalModel, elapsedMs });
      } catch (err) {
        // Send error event FIRST so the client is never left hanging.
        // If the partial-save DB insert below throws, the error event is already sent.
        // send() is already error-safe (swallows enqueue errors),
        // but wrap defensively to ensure the partial-save below is always reachable.
        const detail = extractUpstreamDetail(err);
        const fallbackMsg = err instanceof Error ? err.message : t(locale, "chat.streamError");
        try { send("error", { message: detail.message ?? fallbackMsg, ...(detail.status !== undefined ? { status: detail.status } : {}) }); } catch { /* client already gone */ }
        logger.error("chat", "stream-error", { threadId: body.threadId, model: finalModel, ...(detail.status !== undefined ? { status: detail.status } : {}), ...(detail.upstream ? { upstream: detail.upstream } : {}), error: err instanceof Error ? err.message : String(err) });
        // Save partial assistant content if any was generated before the error
        if (assistantContent) {
          try {
            const [partial] = await db
              .insert(messages)
              .values({
                threadId: body.threadId,
                parentId: prepared.userMessage.id,
                role: "assistant",
                content: assistantContent,
                metadata: buildAssistantMetadata({
                  finalModel,
                  elapsedMs: Date.now() - streamStartedAt,
                  dualTrace,
                  hyperTrace,
                  councilTrace,
                  injectedSkills,
                }),
                reasoning: assistantReasoning || null,
              })
              .returning();
            streamResult.assistantMessageId = partial.id;
            if (injectedSkills.length > 0) {
              await attachUsageMessageIds(
                injectedSkills.map((s) => s.usageEventId),
                partial.id,
                user.id,
              );
            }
            await db
              .update(threads)
              .set({ currentLeafId: partial.id, updatedAt: new Date() })
              .where(eq(threads.id, body.threadId));
          } catch (saveErr) {
            logger.error("chat", "partial-save-failed", { threadId: body.threadId, error: saveErr instanceof Error ? saveErr.message : String(saveErr) });
          }
        }
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

        // Notify the after() callback of completion FIRST, so memory generation
        // proceeds even if controller.close() throws (e.g. client already disconnected).
        resolveStream();

        // Close the stream immediately (lower client's isStreaming).
        logger.info("chat", "stream-complete", { threadId: body.threadId, duration: Date.now() - streamStartedAt, contentLength: assistantContent.length });
        try {
          controller.close();
        } catch {
          // Controller may already be closed if the client disconnected.
        }
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
    // Chat export: append user+assistant pair to the configured path.
    // Runs for all modes (including rapid) — it's a chat record, not memory analysis.
    // Gated on CHAT_EXPORT_PATH: skip the DB title re-read when export is disabled (the default).
    if (process.env.CHAT_EXPORT_PATH?.trim()) {
      try {
        // Re-read thread title (prepareTurn may have updated it for the first message).
        const [exportThread] = await db
          .select({ title: threads.title })
          .from(threads)
          .where(eq(threads.id, body.threadId));
        await appendChatExport({
          threadTitle: exportThread?.title ?? thread.title,
          userContent: prepared.content,
          assistantContent: streamResult.assistantContent,
        });
      } catch (err) {
        logger.error("chat-export", "route callback failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Rapid mode / Cursor provider: skip memory and skill generation (needs OpenAI client).
    if (body.rapid || useCursorProvider) return;
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
        [prepared.userMessage.id, streamResult.assistantMessageId].filter(Boolean) as string[],
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
    undefined,
    getEnvContext(),
  );
  logger.info("search-timing", "decideSearch", { duration: Date.now() - tDecide, searchLevel: decision.searchLevel, queries: decision.queries.length });

  if (decision.searchLevel === "none" || decision.queries.length === 0) {
    logger.info("search-timing", "buildSearchContext total", { duration: Date.now() - tTotal, result: "no search" });
    return null;
  }

  // wiki level: lightweight lookup via Wikipedia REST API (no SearXNG/scraper).
  // On miss, fall through to the web search path with the same queries.
  let webQueries: SearchQuery[] = decision.queries;
  let webStatusLabel = decision.userNotice ?? t(locale, "chat.statusSearchFallback");

  if (decision.searchLevel === "wiki") {
    const tWiki = Date.now();
    const wikiResults = await Promise.all(
      decision.queries.slice(0, 2).map((sq) => searchWikipedia(sq.query).catch(() => null)),
    );
    const valid = wikiResults.filter((r): r is WikipediaResult => r !== null);
    logger.info("search-timing", "wikipedia lookup", { duration: Date.now() - tWiki, found: valid.length });
    if (valid.length > 0) {
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
    // Wiki miss → web fallback (do not stop at training data)
    send("status", { label: t(locale, "chat.statusWikiMissWeb") });
    webStatusLabel = t(locale, "chat.statusWikiMissWeb");
    webQueries = decision.queries.map((sq) => ({
      query: sq.query,
      time_range: null,
      category: null,
    }));
    logger.info("search-timing", "wikipedia miss → web fallback", { queries: webQueries.length });
  } else {
    send("status", { label: webStatusLabel });
  }

  const maxResults = Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3;
  const maxRounds = Math.min(5, Math.max(1, Number(process.env.WEB_SEARCH_MAX_ROUNDS) || 3));
  const searchQueries = webQueries.slice(0, maxRounds);

  type RankedHit = {
    url: string;
    title: string;
    snippet: string;
    content: string;
    score?: number;
    scraped?: boolean;
  };

  const collectHits = async (
    queries: SearchQuery[],
    opts: { dropTimeRange?: boolean; dropCategory?: boolean; rewrite?: boolean } = {},
  ): Promise<RankedHit[]> => {
    const tParallel = Date.now();
    const queryResults = await Promise.all(
      queries.map(async (sq, qi) => {
        const tQuery = Date.now();
        const qText = opts.rewrite ? rewriteQueryForRetry(sq.query) : sq.query;
        const effectiveTimeRange = opts.dropTimeRange ? undefined : (sq.time_range ?? timeRange);
        const category = opts.dropCategory ? null : (sq.category ?? null);
        const queryLanguage = detectSearchLanguage(qText);
        try {
          const response = await searchWeb(
            qText,
            maxResults,
            effectiveTimeRange,
            queryLanguage,
            category,
          );
          logger.info("search-timing", "query", {
            index: qi + 1,
            total: queries.length,
            duration: Date.now() - tQuery,
            results: response.results.length,
            language: queryLanguage,
            category: category ?? "general",
            rewrite: !!opts.rewrite,
          });
          return { query: qText, response };
        } catch {
          logger.info("search-timing", "query", {
            index: qi + 1,
            total: queries.length,
            duration: Date.now() - tQuery,
            results: 0,
            error: true,
          });
          return null;
        }
      }),
    );
    logger.info("search-timing", "all queries parallel", {
      duration: Date.now() - tParallel,
      count: queries.length,
      rewrite: !!opts.rewrite,
    });

    const hits: RankedHit[] = [];
    for (const item of queryResults) {
      if (!item) continue;
      const { query: qText, response } = item;
      for (const r of response.results.slice(0, maxResults)) {
        const rawBody = r.scraped ? r.content : r.raw_content || r.snippet;
        hits.push({
          url: r.url,
          title: r.scrapeTitle || r.title,
          snippet: r.snippet,
          content: sliceContentAroundQuery(rawBody || "", qText, SEARCH_RESULT_CONTENT_SLICE),
          score: r.score,
          scraped: r.scraped,
        });
      }
    }
    // URL dedupe + score rank, then domain quality / diversity
    return applyDomainQualityFilter(dedupeAndRankSearchResults(hits));
  };

  let ranked = await collectHits(searchQueries);

  // Adaptive re-query: when results are empty or have almost no usable body text,
  // retry once with broader queries (no time_range/category, stripped site:/quotes).
  if (isThinSearchResults(ranked) && searchQueries.length > 0) {
    send("status", { label: t(locale, "chat.statusSearchRetry") });
    logger.info("search-timing", "adaptive re-query", { reason: "thin results", prior: ranked.length });
    const retryHits = await collectHits(searchQueries, {
      dropTimeRange: true,
      dropCategory: true,
      rewrite: true,
    });
    if (!isThinSearchResults(retryHits) || retryHits.length > ranked.length) {
      ranked = retryHits;
    }
  }

  const allSources: SourceInfo[] = ranked.map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.snippet,
  }));

  if (allSources.length > 0) send("sources", { sources: allSources });
  if (ranked.length === 0) {
    send("status", { label: t(locale, "chat.statusWebEmpty") });
    // This message only reaches non-tool-supporting models (tool-supporting models
    // have searchContextMessage excluded in effectiveMessages and search autonomously).
    logger.info("search-timing", "buildSearchContext total", { duration: Date.now() - tTotal, result: "no results" });
    return {
      role: "system",
      content: "Web search was attempted but returned no results. Answer from your training data and acknowledge that you could not retrieve current information.",
    };
  }

  // Progressive compression when many results so the model is not flooded with noise.
  const tFormat = Date.now();
  const contextContent = formatSearchResultsForContext(
    ranked.map(({ url, title, snippet, content }) => ({ url, title, snippet, content })),
  );
  logger.info("search-timing", "format-context", { duration: Date.now() - tFormat, chars: contextContent.length, results: ranked.length });

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

/**
 * Build assistant message metadata with spread merge — never replaces
 * dual/hyper/council traces when adding injectedSkills.
 * Used on both success and partial-error save paths.
 */
export function buildAssistantMetadata(args: {
  finalModel: string;
  elapsedMs: number;
  dualTrace?: DualTrace;
  hyperTrace?: HyperTrace;
  councilTrace?: CouncilTrace;
  injectedSkills: InjectedSkillInfo[];
}) {
  return {
    model: args.finalModel,
    elapsedMs: args.elapsedMs,
    ...(args.dualTrace ? { dualTrace: args.dualTrace } : {}),
    ...(args.hyperTrace ? { hyperTrace: args.hyperTrace } : {}),
    ...(args.councilTrace ? { councilTrace: args.councilTrace } : {}),
    ...(args.injectedSkills.length > 0
      ? { injectedSkills: args.injectedSkills }
      : {}),
  };
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
  knowledgeMessage,
  useTools,
}: {
  systemContent?: string | null;
  personalizationContent?: string | null;
  history: DbMessage[];
  content: string;
  searchContextMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam | null;
  urlContextMessage?: OpenAI.Chat.Completions.ChatCompletionMessageParam | null;
  skillMessage?: { role: "system"; content: string } | null;
  memoryMessage?: { role: "system"; content: string } | null;
  knowledgeMessage?: { role: "system"; content: string } | null;
  useTools?: boolean;
}): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const toolGuardMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam | null = useTools
    ? {
        role: "system" as const,
        content:
          "TOOL USE RULES (mandatory — violating these causes user harm):\n" +
          "1. NEVER claim you checked/read/found something without an actual tool call returning that result. " +
          "If you have not called a tool, you do not know it.\n" +
          "2. If a tool returns empty output, an error, or 'not found', report that honestly. " +
          "Do NOT fabricate plausible-sounding content to fill the gap.\n" +
          "3. Do not repeat the same exploration more than twice. If two tool calls returned nothing, " +
          "state what you could not find and ask the user for guidance.\n" +
          "4. When a tool result is truncated, say 'output was truncated' — do not guess the missing part.\n" +
          "5. Distinguish explicitly between 'confirmed via tool output' and 'inferred'. " +
          "Use the exact phrasing: '[CONFIRMED]' vs '[INFERRED]'.\n" +
          "6. Files generated inside sandbox_run are NOT visible to the host until saved via outputFiles. " +
          "Never tell the user a file was written unless it appears in the tool result's outputs field.\n" +
          "7. When you call exploration tools, you MUST report the actual output in your response. " +
          "Do NOT say 'I checked it' without quoting what the tool returned. " +
          "If the tool returned a file list, paste the list. If it returned file contents, summarize with quotes.\n" +
          "8. Do NOT ask the user 'where is the file' if you have not yet searched with tools first. " +
          "Explore with tools before asking.\n" +
          "9. If a tool call returned results but you cannot find what you need in them, say exactly: " +
          "'I looked at [X] using [tool] and found [Y], but could not find [Z].' " +
          "Do NOT say 'I couldn't see it' if you haven't called the tool.\n" +
          "10. Codebase exploration: prefer `search_files` (glob) and `grep_content` (text/regex) over " +
          "repeated `list_directory`. Use `read_file` for known paths. " +
          "Do NOT chain shallow list_directory calls guessing folder names. " +
          "Reserve `sandbox_run` for executing code, not for file exploration.\n" +
          "11. Multi-step agent work: after tools finish, you MUST produce a user-visible answer in message content. " +
          "Thinking is not the answer. Server hooks will force a final report if content is missing — still write it yourself.\n" +
          "12. Knowledge bases from bulk data: prefer `kb_from_jsonl` (create + ingest, optional field filters) or " +
          "`kb_ingest_jsonl` into an existing KB. JSONL = one JSON object per line with content/text (+ title/name). " +
          "Filters: filter_equals / filter_contains / filter_any_fields+filter_any_value on any top-level fields. " +
          "Do NOT read multi-MB JSONL with read_file; do not hand-filter in sandbox. " +
          "To transform proprietary source formats into JSONL, use sandbox_run or write_file, then kb_from_jsonl. " +
          "Sandbox: read /workspace, write /out only + outputFiles.\n" +
          "13. Editing existing files: prefer `edit_file` (str_replace) over `write_file` for partial edits. " +
          "Use `write_file` only for new files or full rewrites. Copy the exact snippet from read_file as old_string.\n" +
          "14. Tool outcome hints: when a tool result includes `next:` guidance, follow it. " +
          "Do NOT repeat the same arguments after an error or empty result.",
      }
    : null;
  const richBlockMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: "system" as const,
    content:
      "RICH MARKDOWN BLOCKS (optional, use only when they aid clarity — never overuse):\n" +
      "1. Callout: :::callout{type=\"note|tip|warning|danger\"}\ncontent\n::: — for important notes/suggestions/warnings. Optional title: :::callout{type=\"tip\" title=\"Hint\"}\n2. Inline styling: :mark[text]{.big|.small|.accent|.muted|.danger|.success|.hl} — on a minimal emphasized word only, never a whole sentence.\n" +
      "3. Rich list: :::richlist{marker=\"check|cross|star|arrow|info|warning\"}\n- item\n::: — only when order/classification is meaningful.\n" +
      "Rules: do NOT use these when plain Markdown suffices. Use the exact type/marker/class values listed. Unknown values fall back to defaults.",
  };
  return [
    { role: "system" as const, content: getEnvContext() },
    ...(personalizationContent ? [{ role: "system" as const, content: personalizationContent }] : []),
    ...(systemContent ? [{ role: "system" as const, content: systemContent }] : []),
    ...(toolGuardMessage ? [toolGuardMessage] : []),
    richBlockMessage,
    ...(skillMessage ? [skillMessage] : []),
    ...(memoryMessage ? [memoryMessage] : []),
    ...(knowledgeMessage ? [knowledgeMessage] : []),
    ...history.map(
      (m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam,
    ),
    ...(searchContextMessage ? [searchContextMessage] : []),
    ...(urlContextMessage ? [urlContextMessage] : []),
    { role: "user" as const, content },
  ];
}

async function runHyperThinkingFlow({
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
}): Promise<{ trace: HyperTrace; finalMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] }> {
  const rounds = Math.min(5, Math.max(1, thread.hyperRounds ?? 3));
  const perspectives = HYPER_PERSPECTIVES;

  // Initial draft generation
  send("status", { label: t(locale, "chat.statusHyperDraft") });
  let currentDraft = await completeText(
    llm,
    finalModel,
    withHyperInstruction(baseMessages, "Generate your best initial answer to the user's request. Be thorough and precise."),
  );

  const traceRounds: HyperTrace["rounds"] = [];

  for (let i = 0; i < rounds; i++) {
    const perspective = perspectives[i % perspectives.length];

    // Self-critique: verify the current draft from a different perspective
    send("status", { label: t(locale, "chat.statusHyperCritique", { round: String(i + 1), total: String(rounds), perspective }) });
    const critique = await completeText(
      llm,
      finalModel,
      [
        ...baseMessages,
        { role: "assistant", content: currentDraft },
        { role: "user", content: `Review your answer above from the perspective of "${perspective}". Identify factual errors, logical gaps, missing edge cases, and areas for improvement. Be specific and critical. Do not rewrite the answer yet.` },
      ],
    );

    // Revised answer: improve based on the critique
    send("status", { label: t(locale, "chat.statusHyperRevise", { round: String(i + 1), total: String(rounds) }) });
    const revised = await completeText(
      llm,
      finalModel,
      [
        ...baseMessages,
        { role: "assistant", content: currentDraft },
        { role: "user", content: `Critique from "${perspective}" perspective:\n${critique}\n\nBased on this critique, provide an improved answer to the original user request. Address all identified issues. Output only the revised answer.` },
      ],
    );

    traceRounds.push({ perspective, draft: currentDraft, critique, revised });
    currentDraft = revised;
  }

  const trace: HyperTrace = {
    rounds: traceRounds,
    finalModel,
  };

  return {
    trace,
    finalMessages: buildHyperSynthesisMessages(baseMessages, currentDraft),
  };
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

function withHyperInstruction(
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  instruction: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    ...baseMessages,
    { role: "system", content: instruction },
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

function buildHyperSynthesisMessages(
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  finalDraft: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    ...baseMessages,
    {
      role: "system",
      content:
        "You are giving the final answer after multiple rounds of self-review and refinement. " +
        "The improved answer below is your best answer. Output it directly, with no meta-commentary about the review process.",
    },
    { role: "assistant", content: finalDraft },
    { role: "user", content: "Provide the final answer to the original request based on the refined answer above." },
  ];
}

async function runCouncilFlow({
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
}): Promise<{ trace: CouncilTrace; finalMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] }> {
  const councilSize = Math.min(6, Math.max(2, thread.councilSize ?? 3));
  const timeLimitMs = Math.min(21600, Math.max(30, thread.councilTimeLimit ?? 60)) * 1000;

  // 1. Generate N distinct personas optimized for the user's question
  send("status", { label: t(locale, "chat.statusCouncilPersonas") });
  const personas = await generateCouncilPersonas(llm, finalModel, baseMessages, councilSize);

  const panels: CouncilPanel[] = personas.map((persona, i) => ({
    id: `panel-${i + 1}`,
    persona,
    model: finalModel,
  }));
  send("council_panels", { councilPanels: panels, councilFinalModel: finalModel });

  // 2. Each panel generates an initial answer sequentially
  const initialAnswers: { panelId: string; content: string }[] = [];
  for (const panel of panels) {
    send("status", { label: t(locale, "chat.statusCouncilInitial", { panel: panel.id }) });
    const answer = await completeText(
      llm,
      finalModel,
      withCouncilPersona(baseMessages, panel.persona, "Provide your initial answer to the user's question. Answer directly from your persona's perspective."),
    );
    initialAnswers.push({ panelId: panel.id, content: answer });
    send("council_initial", { councilPanelId: panel.id, councilContent: answer });
  }

  // 3. Discussion rounds (repeat within time limit)
  // Timer starts here (persona generation + initial answers are not counted)
  const discussionStartedAt = Date.now();
  const discussionTurns: { panelId: string; round: number; content: string }[] = [];
  let round = 0;
  let timeLimitReached = false;

  while (Date.now() - discussionStartedAt < timeLimitMs) {
    round++;
    send("status", { label: t(locale, "chat.statusCouncilRound", { round: String(round) }) });

    for (const panel of panels) {
      if (Date.now() - discussionStartedAt >= timeLimitMs) {
        timeLimitReached = true;
        break;
      }
      send("status", { label: t(locale, "chat.statusCouncilPanel", { panel: panel.id, round: String(round) }) });
      const transcript = formatCouncilTranscript(panels, initialAnswers, discussionTurns);
      const turn = await completeText(
        llm,
        finalModel,
        withCouncilPersona(baseMessages, panel.persona, `Discussion so far:\n${transcript}\n\nAs your persona, respond to the discussion. You may agree, disagree, add nuance, or correct errors. Be concise but substantive.`),
      );
      discussionTurns.push({ panelId: panel.id, round, content: turn });
      send("council_turn", { councilPanelId: panel.id, councilRound: round, councilContent: turn });
    }
    if (timeLimitReached) break;
  }

  const trace: CouncilTrace = {
    panels,
    initialAnswers,
    discussionTurns,
    finalModel,
    roundsCompleted: round,
    timeLimitReached,
  };

  return {
    trace,
    finalMessages: buildCouncilSynthesisMessages(baseMessages, trace),
  };
}

async function generateCouncilPersonas(
  llm: OpenAI,
  model: string,
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  count: number,
): Promise<string[]> {
  const personaPrompt = `You are a persona designer. The user has asked a question. Generate ${count} distinct expert personas who would approach this question from radically different angles. Each persona should have a unique perspective, background, and methodology. Return ONLY a JSON array of ${count} strings, each string being a persona description (name + expertise + thinking style in 1-2 sentences). Example format: ["Dr. Ada Chen — systems architect who thinks in terms of tradeoffs and edge cases", "Marcus Webb — pragmatic engineer who values simplicity and shipping", ...]`;
  const result = await completeText(llm, model, [
    ...baseMessages,
    { role: "system", content: personaPrompt },
    { role: "user", content: "Generate the personas now." },
  ]);
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
      return parsed.slice(0, count);
    }
  } catch {
    const lines = result.split(/\n|\d+\./).map((s) => s.trim()).filter(Boolean);
    if (lines.length >= count) return lines.slice(0, count);
  }
  const defaults = [
    "Analytical thinker — breaks problems into components, values data and evidence",
    "Creative synthesizer — sees unexpected connections, values novel approaches",
    "Practical pragmatist — focuses on what actually works in practice",
    "Devil's advocate — challenges assumptions and finds weaknesses",
    "Systems thinker — considers second-order effects and long-term implications",
    "User advocate — prioritizes the end-user experience and accessibility",
  ];
  return defaults.slice(0, count);
}

function withCouncilPersona(
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  persona: string,
  instruction: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    ...baseMessages,
    {
      role: "system",
      content: `Your persona: ${persona}\n\n${instruction}\n\nStay in character. Do not mention that you are playing a role.`,
    },
  ];
}

function formatCouncilTranscript(
  panels: CouncilPanel[],
  initialAnswers: { panelId: string; content: string }[],
  turns: { panelId: string; round: number; content: string }[],
): string {
  const panelMap = new Map(panels.map((p) => [p.id, p]));
  const lines: string[] = [];
  for (const ans of initialAnswers) {
    const panel = panelMap.get(ans.panelId);
    lines.push(`[${ans.panelId} (${panel?.persona ?? "Unknown"}) — Initial answer]:\n${ans.content}`);
  }
  for (const turn of turns) {
    const panel = panelMap.get(turn.panelId);
    lines.push(`[${turn.panelId} (${panel?.persona ?? "Unknown"}) — Round ${turn.round}]:\n${turn.content}`);
  }
  return lines.join("\n\n");
}

function buildCouncilSynthesisMessages(
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  trace: CouncilTrace,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const transcript = formatCouncilTranscript(trace.panels, trace.initialAnswers, trace.discussionTurns);
  return [
    ...baseMessages,
    {
      role: "system",
      content:
        "You are the final synthesizer. A council of AI panels with different personas has discussed the user's question. " +
        "Review the full discussion below and provide the best possible final answer. " +
        "Synthesize the strongest points, resolve disagreements, and present a coherent conclusion. " +
        "Do not mention the discussion process unless it adds value to the answer.",
    },
    { role: "assistant", content: `Council discussion transcript:\n${transcript}` },
    { role: "user", content: "Provide the final answer based on the council discussion." },
  ];
}
async function completeText(
  llm: OpenAI,
  model: string,
  messagesForModel: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  options?: { maxTokens?: number; reasoningEffort?: OpenAI.ReasoningEffort | null; disableThinking?: boolean },
): Promise<string> {
  const shouldDisable = options?.disableThinking || options?.reasoningEffort === "none";
  const disableParams = shouldDisable ? await buildDisableReasoningParams(model) : {};
  const completion = await llm.chat.completions.create({
    model,
    messages: messagesForModel,
    stream: false,
    ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(shouldDisable
      ? {}
      : options?.reasoningEffort
        ? { reasoning_effort: options.reasoningEffort }
        : {}),
    ...disableParams,
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
  return completion.choices[0]?.message?.content?.trim() ?? "";
}

const HYPER_PERSPECTIVES = [
  "factual accuracy and correctness",
  "logical consistency and soundness of reasoning",
  "completeness — missing edge cases, exceptions, or important context",
  "clarity and conciseness — removing unnecessary verbosity",
  "practical applicability and actionability",
];

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
        "Search the web for current information using SearXNG. Use when you need facts you are not confident about. IMPORTANT: Pass keyword-based queries (e.g. 'AI news July 2026'), NOT natural-language questions (e.g. 'What is today's AI news?'). Quote proper nouns/versions with double quotes; use site: when a domain is clearly relevant (e.g. site:store.steampowered.com). Include the date when searching for time-sensitive information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword search query (not a full sentence)" },
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
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file within the workspace. Returns the text content. Use when you already know the path (from search_files, grep_content, or the user).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace root (e.g. 'src/main.ts', 'config.json'). Use absolute paths only if inside workspace." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write text content to a file within the workspace. Creates parent directories if needed. Overwrites existing files. Use for creating or editing source code, config files, etc.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace root" },
          content: { type: "string", description: "The text content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit an existing file by replacing an exact string (str_replace). PREFERRED over write_file for partial edits. " +
        "old_string must match exactly (copy from read_file). If old_string matches multiple locations, set replace_all=true or add more context. " +
        "Returns an error (not a silent overwrite) if old_string is not found. Use write_file only for new files or full rewrites.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace root" },
          old_string: { type: "string", description: "The exact text to find (must match the file content exactly)" },
          new_string: { type: "string", description: "The replacement text" },
          replace_all: { type: "boolean", description: "Replace all occurrences (default false). Required if old_string is not unique." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List files and directories at a path. depth=1 (default) is a single level; raise depth (max 6) for a shallow tree. " +
        "For finding files by name pattern or text content, prefer search_files / grep_content instead of repeated list_directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace root. Use '.' for workspace root." },
          depth: {
            type: "number",
            description: "How many directory levels to include (default 1, max 6). Use 2–3 for a compact tree.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Find files by glob pattern under the workspace (e.g. '**/*.json', '**/Story*.tsx', 'package.json'). " +
        "PREFERRED for locating files. Returns matching paths or [SEARCH empty] if none. Skips node_modules/.git/.next.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern. Supports *, **, ?. Examples: '**/*.ts', 'data/**/*.json', 'README*'",
          },
          path: {
            type: "string",
            description: "Optional subdirectory to search under (relative to workspace root). Default '.'",
          },
          max_results: {
            type: "number",
            description: "Max paths to return (default 200)",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_content",
      description:
        "Search file contents with a regex or fixed string (like ripgrep). " +
        "PREFERRED for finding symbols, field names, imports, or UI labels. " +
        "Returns path:line:snippet lines or [GREP empty] if none. Skips node_modules/.git/.next and binary files.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern (default) or fixed string when fixed_string=true",
          },
          path: {
            type: "string",
            description: "Optional subdirectory to search under. Default '.'",
          },
          glob: {
            type: "string",
            description: "Optional file-name glob filter (e.g. '*.ts', '**/*.{ts,tsx}')",
          },
          case_insensitive: {
            type: "boolean",
            description: "Case-insensitive match (default true)",
          },
          fixed_string: {
            type: "boolean",
            description: "Treat pattern as literal text, not regex (default false)",
          },
          max_matches: {
            type: "number",
            description: "Max match lines to return (default 100)",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a whitelisted shell command in the workspace directory. Allowed: git (read-only: status, log, diff, show, branch, blame, remote, ls-files, etc.), ls, cat, head, tail, grep, rg, find, wc, echo, pwd, tree, file. Blocked: node, npm, bun, python, curl, wget, rm, shells, and all write operations. Output (stdout+stderr) is returned. 30-second timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_logs",
      description: "Read the application's own process logs to diagnose errors, crashes, or unexpected behavior. Returns recent log lines from either Docker container logs (in Docker) or the log file (in exe). Use when investigating errors, crashes, or debugging issues.",
      parameters: {
        type: "object",
        properties: {
          tailLines: {
            type: "number",
            description: "Number of recent log lines to retrieve (default 200, max 2000)",
          },
          minLevel: {
            type: "string",
            enum: ["debug", "info", "warn", "error"],
            description: "Minimum log level to include, for file-based logs (default 'info'). Ignored in Docker mode.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_create",
      description: "Create a new todo item (task) for the user. Use when the user asks to add, create, or schedule a task.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The todo title" },
          description: { type: "string", description: "Optional description or notes" },
          priority: { type: "string", enum: ["low", "medium", "high"], description: "Priority level (default: medium)" },
          due_at: { type: "string", description: "Due date in ISO 8601 format (e.g. 2026-07-15T00:00:00Z)" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_list",
      description: "List the user's todo items. Use when the user asks what tasks they have, or wants to see their todo list.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "in_progress", "completed", "all"], description: "Filter by status (default: all)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_update",
      description: "Update an existing todo item (change title, description, status, priority, or due date). Use when the user asks to modify, complete, or reschedule a task.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The todo id" },
          title: { type: "string", description: "New title" },
          description: { type: "string", description: "New description" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "New status" },
          priority: { type: "string", enum: ["low", "medium", "high"], description: "New priority" },
          due_at: { type: "string", description: "New due date in ISO 8601 format, or null to clear" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_delete",
      description: "Delete a todo item. Use when the user asks to remove or delete a task.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The todo id to delete" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_list",
      description: "List the user's saved skills (reusable behavior instructions). Set include_duplicates=true to also detect semantically similar skill pairs for cleanup. Use when the user asks to see, review, or deduplicate their skills.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "archived", "all"], description: "Filter by status (default: all)" },
          include_duplicates: { type: "boolean", description: "If true, annotate each skill with a 'duplicates' array listing similar skills (similarity >= 0.88). Use for detecting redundant skills to clean up." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_create",
      description: "Create a new skill (reusable instruction that will be automatically injected into future conversations when relevant). Use when the user asks to save, create, or register a skill. Returns error if an identical skill already exists.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short skill name (2-5 words)" },
          content: { type: "string", description: "The skill instructions in second person (You should... / When X happens, do Y)" },
          kind: { type: "string", enum: ["workflow", "bugfix", "project_rule", "tool_usage", "coding_pattern", "debugging"], description: "Skill category (default: workflow)" },
          trigger: { type: "string", description: "When to apply this skill (natural language)" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for searchability" },
        },
        required: ["name", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_update",
      description: "Update an existing skill's content, name, trigger, tags, or status. Use when the user asks to modify, refine, or archive a skill. Content changes re-embed and increment version.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The skill id" },
          name: { type: "string", description: "New name" },
          content: { type: "string", description: "New content instructions" },
          trigger: { type: "string", description: "New trigger condition" },
          tags: { type: "array", items: { type: "string" }, description: "New tags" },
          status: { type: "string", enum: ["active", "archived"], description: "Set to 'archived' to archive, 'active' to restore" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_delete",
      description: "Delete a skill permanently. Use when the user asks to remove a skill, especially redundant duplicates identified via skill_list with include_duplicates.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The skill id to delete" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_create",
      description: "CRITICAL: You MUST call this tool to create a knowledge base. Do NOT say 'created' without calling this tool — the user will verify in the UI. Creates a new knowledge base (RAG database). Call this when the user asks to create a knowledge base. Returns the KB id needed for kb_ingest.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Knowledge base name (e.g. 'Game Story Data', 'Work Documents')" },
          description: { type: "string", description: "Optional description of what this KB contains" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_list",
      description:
        "CRITICAL: You MUST call this tool to list knowledge bases. Do NOT fabricate KB names or claim they exist without calling this tool. " +
        "Returns id, name, description, documentCount, createdAt. Use documentCount to see if a KB is empty.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_delete",
      description:
        "CRITICAL: Permanently delete a knowledge base and all its documents/chunks. " +
        "Use when cleaning duplicate or obsolete KBs (call kb_list first for ids). " +
        "Call kb_list first to get ids. Returns whether deletion succeeded.",
      parameters: {
        type: "object",
        properties: {
          knowledge_base_id: { type: "string", description: "KB id from kb_list" },
        },
        required: ["knowledge_base_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_ingest",
      description:
        "CRITICAL: You MUST call this tool to add documents to a knowledge base. Do NOT say 'ingested' or 'saved' without calling this tool — the data will NOT be stored. " +
        "For a single document only. For many docs (e.g. per-character dialogue), write a JSONL file then use kb_ingest_jsonl. " +
        "Prefer many focused docs over one giant blob so retrieval is precise. Returns the document id and chunk count.",
      parameters: {
        type: "object",
        properties: {
          knowledge_base_id: { type: "string", description: "The knowledge base id (from kb_list)" },
          title: { type: "string", description: "Document title" },
          content: { type: "string", description: "The text content to ingest. Will be chunked (~512 chars) and embedded." },
          source_url: { type: "string", description: "Optional source URL. If provided, the server scrapes the URL to get full page content instead of using 'content'." },
        },
        required: ["knowledge_base_id", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_search",
      description: "CRITICAL: You MUST call this tool to search a knowledge base. Do NOT fabricate search results or quote content without calling this tool — fabricated results mislead the user. Returns actual matching chunks with similarity scores from the database.",
      parameters: {
        type: "object",
        properties: {
          knowledge_base_id: { type: "string", description: "The knowledge base id to search" },
          query: { type: "string", description: "The search query" },
        },
        required: ["knowledge_base_id", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_ingest_folder",
      description: "CRITICAL: You MUST call this tool to bulk-import a folder into a knowledge base. Do NOT claim files were ingested without calling this tool — the data will NOT be stored. Returns the count of files ingested, skipped, and errors. Each text file becomes one document with chunked embeddings.",
      parameters: {
        type: "object",
        properties: {
          knowledge_base_id: { type: "string", description: "The knowledge base id (from kb_list)" },
          folder_path: { type: "string", description: "Path relative to workspace root (e.g. 'docs', 'src', '.'). The folder must exist in the workspace." },
        },
        required: ["knowledge_base_id", "folder_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_ingest_jsonl",
      description:
        "CRITICAL: Bulk-ingest a workspace JSONL file into an EXISTING knowledge base (one JSON object per line → one document). " +
        "Optional generic field filters (filter_equals / filter_contains / filter_any_*) keep only matching lines. " +
        "To create a new KB and ingest in one step, prefer kb_from_jsonl. " +
        "Do NOT claim bulk ingest without calling this tool. Returns counts: ingested, skipped, cached, errors, sample titles.",
      parameters: {
        type: "object",
        properties: {
          knowledge_base_id: { type: "string", description: "The knowledge base id (from kb_create or kb_list)" },
          path: {
            type: "string",
            description: "Workspace-relative path to the JSONL file (e.g. 'rag/character_dialogue.jsonl')",
          },
          max_lines: {
            type: "number",
            description: "Safety cap on lines to ingest (default 10000, max 20000)",
          },
          filter_equals: {
            type: "string",
            description: "Optional exact field matches as k=v pairs, e.g. 'kind=note,project=alpha'",
          },
          filter_contains: {
            type: "string",
            description: "Optional substring field matches as k=v pairs, e.g. 'name=愛' or 'title=プロジェクトA'",
          },
          filter_any_fields: {
            type: "string",
            description: "Optional comma-separated fields for OR contains (with filter_any_value), e.g. 'name,title,tags'",
          },
          filter_any_value: {
            type: "string",
            description: "Value that must appear in at least one of filter_any_fields",
          },
          filter_json: {
            type: "string",
            description: "Optional full filter as JSON: {equals,contains,in,anyFieldContains}",
          },
        },
        required: ["knowledge_base_id", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_from_jsonl",
      description:
        "One-shot: create a knowledge base from a workspace JSONL (optionally filtered by any top-level fields), " +
        "then bulk-ingest. Use for full or subset KBs by name, title, kind, tag, project, author, etc. " +
        "Replaces same-name KBs by default. Do NOT read multi-MB JSONL with read_file — apply filters here. " +
        "If source data is not JSONL yet, transform with sandbox_run/write_file first, then call this tool.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "New knowledge base name (e.g. 'work-docs-q3', 'project-notes')",
          },
          path: {
            type: "string",
            description: "Workspace-relative JSONL path (one JSON object per line with content/text)",
          },
          description: {
            type: "string",
            description: "Optional KB description",
          },
          filter_equals: {
            type: "string",
            description: "Exact field matches: 'kind=article,project=alpha'",
          },
          filter_contains: {
            type: "string",
            description: "Substring field matches: 'title=契約' or 'name=Alice'",
          },
          filter_any_fields: {
            type: "string",
            description: "OR-contains fields: 'name,title,tags' (with filter_any_value)",
          },
          filter_any_value: {
            type: "string",
            description: "Needle for filter_any_fields",
          },
          filter_json: {
            type: "string",
            description: "Full filter JSON if needed",
          },
          max_lines: {
            type: "number",
            description: "Safety cap (default 10000, max 20000)",
          },
          replace_existing: {
            type: "boolean",
            description: "Delete existing KBs with the same name first (default true)",
          },
        },
        required: ["name", "path"],
      },
    },
  },
];

/** Enough rounds for multi-step agent work (explore → script → run → kb_ingest → verify). */
const MAX_TOOL_ROUNDS = 12;

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
  userId,
  threadId,
  onModelFallback,
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
  userId: string;
  threadId?: string | null;
  onModelFallback?: (model: string) => void;
}) {
  const llmStreamStartedAt = Date.now();
  logger.info("chat", "llm-stream-start", { model });
  const thinkingEffort = process.env.THINKING_EFFORT;

  // TTFT fallback configuration
  const fbModel = fallbackModel();
  const fbTimeoutMs = fallbackTimeoutMs();
  const fallbackEnabled = fbModel !== null && onModelFallback !== undefined;

  // modelToUse may change on fallback. reasoningParams are derived from modelToUse.
  let modelToUse = model;
  let reasoningEffort = thinkingEffort && (await getReasoningLevels(modelToUse)).includes(thinkingEffort)
    ? thinkingEffort
    : await getDefaultReasoningEffort(modelToUse);
  let disableReasoningParams = await buildDisableReasoningParams(modelToUse);

  const useTools = toolSupport?.supported === true && send !== undefined;
  const searchMaxResults = Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3;

  let currentMessages = messagesForModel;
  let rounds = 0;
  // Track user-visible answer length (thinking does not count). Used by agent
  // hooks to force a final content turn / auto-report when the model only thinks.
  let emittedContentChars = 0;
  const emitContent = (delta: string) => {
    if (!delta) return;
    emittedContentChars += delta.length;
    onDelta(delta);
  };
  /** OMP-style tool transcript for post-tool report hooks. */
  const toolTranscript: ToolTranscriptEntry[] = [];

  // Tool-use mode: when tool_calls are detected during streaming,
  // execute the tools, append results as tool role messages, and re-stream.
  // Up to MAX_TOOL_ROUNDS times. Beyond that, continue answering without tools.
  let fallbackRetried = false;

  // Loop detection: track tool call signatures to detect repeated identical
  // calls (a common GLM-5.2 hallucination pattern where it keeps calling the
  // same tool with the same args, never making progress).
  const loopGuardState = createLoopGuardState();
  let useToolsThisRoundOverride = true;
  // OMP-style: if the model stops mid-task with no tool_calls (thinking-only
  // or tiny body), re-enter the loop with tools still on instead of exiting.
  const maxContinueRetries = agentContinueRetriesFromEnv();
  let continueRetriesUsed = 0;
  while (true) {
    const useToolsThisRound = useTools && !fallbackRetried && rounds < MAX_TOOL_ROUNDS && useToolsThisRoundOverride;
    // Re-enable tools after a loop-break round (override was set false
    // to skip one round, then restored so different calls can proceed).
    if (!useToolsThisRoundOverride) useToolsThisRoundOverride = true;

    // TTFT timeout: only on the first round, before any delta has been received.
    // Once we fall back (or fallback is disabled), no timeout is set.
    const needsTtftTimeout = fallbackEnabled && !fallbackRetried && rounds === 0;
    const abortCtl = needsTtftTimeout ? new AbortController() : null;
    const ttftTimer = needsTtftTimeout
      ? setTimeout(() => abortCtl!.abort(), fbTimeoutMs!)
      : null;

    let firstDeltaReceived = false;

    try {
      const completion = await llm.chat.completions.create({
        model: modelToUse,
        messages: currentMessages,
        stream: true,
        // Keep reasoning on during tool rounds so the model can plan exploration
        // (disabling thinking only when effort is explicitly "none"). Tool-time
        // thinking-off was a major cause of shallow list_directory loops + fabrication.
        ...(reasoningEffort === "none"
          ? disableReasoningParams
          : reasoningEffort && (await getReasoningLevels(modelToUse)).includes(reasoningEffort)
            ? { reasoning_effort: reasoningEffort }
            : {}),
        ...(useToolsThisRound
          ? { tools: [...STREAM_TOOLS, ...(extraTools ?? [])], tool_choice: "auto" }
          : {}),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        needsTtftTimeout ? { signal: abortCtl!.signal } : undefined);

      // Accumulate tool_calls deltas during streaming.
      // In OpenAI's streaming format, tool_calls arrive split across chunks,
      // so we join them by index.
      const toolCallAccumulator: Record<
        number,
        { id: string; name: string; arguments: string }
      > = {};
      let hadToolCalls = false;
      // When tools are offered, buffer content until we know whether this round
      // is a tool-call round. Intermediate "I confirmed X" narration must not
      // hit the UI or the saved assistant answer (see toolStreamPolicy).
      let contentBuffer = "";

      for await (const chunk of completion) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta as Record<string, unknown> | undefined;
        const reasoningDelta =
          delta && typeof delta === "object" && "reasoning_content" in delta && typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : undefined;
        if (reasoningDelta) {
          if (!firstDeltaReceived) {
            firstDeltaReceived = true;
            clearTimeout(ttftTimer ?? undefined);
          }
          // Thinking stays visible during tool rounds (plan/explore); only answer prose is gated.
          onReasoning(reasoningDelta);
        }
        const contentDelta = choice.delta?.content;
        if (contentDelta) {
          if (!firstDeltaReceived) {
            firstDeltaReceived = true;
            clearTimeout(ttftTimer ?? undefined);
          }
          if (useToolsThisRound) {
            contentBuffer += contentDelta;
          } else {
            emitContent(contentDelta);
          }
        }

        // Accumulate tool_calls delta
        const deltaToolCalls =
          delta && typeof delta === "object" && "tool_calls" in delta && Array.isArray(delta.tool_calls)
            ? (delta.tool_calls as Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>)
            : undefined;
        if (deltaToolCalls) {
          hadToolCalls = true;
          if (!firstDeltaReceived) {
            firstDeltaReceived = true;
            clearTimeout(ttftTimer ?? undefined);
          }
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

      clearTimeout(ttftTimer ?? undefined);

      // Flush or discard buffered answer prose for tools-offered rounds.
      const toEmit = resolveBufferedToolRoundContent({
        toolsOffered: useToolsThisRound,
        hadToolCalls,
        bufferedContent: contentBuffer,
      });
      if (toEmit) {
        emitContent(toEmit);
      } else if (useToolsThisRound && hadToolCalls && contentBuffer.length > 0) {
        logger.info("chat", "discarded-tool-round-content", {
          chars: contentBuffer.length,
          round: rounds + 1,
        });
      }

      if (!hadToolCalls || !useToolsThisRound) {
        // OMP-style continue: model produced no tool_calls this round but the
        // user task is not finished (thinking-only / empty body / tiny report
        // after tools). Re-prompt with tools still available instead of exiting.
        const continueDecision = decideContinueToolLoop({
          hadToolCalls,
          toolsWereOffered: useToolsThisRound,
          emittedContentChars,
          toolRounds: rounds,
          toolResultCount: toolTranscript.length,
          continueRetriesUsed,
          maxContinueRetries,
          maxToolRounds: MAX_TOOL_ROUNDS,
          minChars: agentContinueMinCharsFromEnv(),
          lastAssistantText: contentBuffer || undefined,
          unfinishedToolWork: toolTranscript.slice(-6).some(
            (te) => te.content.includes("status=error") || te.content.includes("status=empty") || te.content.includes("status=blocked"),
          ),
        });
        if (continueDecision.shouldContinue) {
          continueRetriesUsed++;
          logger.warn("chat", "agent-continue-loop", {
            model: modelToUse,
            continueRetriesUsed,
            maxContinueRetries,
            toolRounds: rounds,
            toolResults: toolTranscript.length,
            emittedContentChars,
            reason: continueDecision.reason,
          });
          send?.("status", {
            label: t(locale, "chat.statusAgentContinue", {
              n: String(continueRetriesUsed),
              max: String(maxContinueRetries),
            }),
          });
          currentMessages = [
            ...currentMessages,
            {
              role: "system" as const,
              content: buildContinueAgentPrompt({
                toolTranscript,
                continueRetriesUsed,
                maxContinueRetries,
              }),
            },
          ];
          // Keep tools on; do not increment toolRounds (no tool executed yet).
          continue;
        }
        // No tool calls, or max rounds exceeded, or continue budget exhausted → done
        break;
      }

      rounds++;

      // Execute tool calls
      const toolCalls = Object.values(toolCallAccumulator).filter((tc) => tc.name);

      // Loop detection: check if any tool call is a duplicate of a previous call.
      // Anti-loop guard: G1 (duplicate signature), G2 (empty exploration streak),
      // G3 (same-path list_directory spam). Replaces inline seenToolCalls logic.
      const guardResult = precheckToolCalls(loopGuardState, toolCalls);
      if (guardResult.blocked && guardResult.results) {
        logger.warn("chat", "tool-loop-detected", {
          round: rounds,
          tools: toolCalls.map((tc) => tc.name),
        });
        // Inject blocked results for ALL tool calls in this round,
        // then force the next round to proceed without tools.
        currentMessages = [
          ...currentMessages,
          {
            role: "assistant" as const,
            content: null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam,
          ...toolCalls.map((tc, i): OpenAI.Chat.Completions.ChatCompletionToolMessageParam => ({
            role: "tool" as const,
            tool_call_id: tc.id,
            content: formatToolOutcomeForModel(guardResult.results![i]!),
          })),
          { role: "system" as const, content: TOOL_GROUNDING_REMINDER },
        ];
        send?.("status", { label: t(locale, "chat.statusToolLoopDetected") });
        // Disable tools for ONE round to break the loop, then re-enable
        // so the AI can make a different useful call if needed.
        useToolsThisRoundOverride = false;
        continue;
      }
      // Add assistant message (including tool_calls) to history
      currentMessages = [
        ...currentMessages,
        {
          role: "assistant" as const,
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
        let toolContent: string = "";
        let toolOutcome: ToolOutcome | null = null;
        let parsedArgs: {
          url?: string; query?: string; path?: string; content?: string; command?: string;
          tailLines?: number; minLevel?: string; title?: string; description?: string;
          priority?: string; due_at?: string | null; status?: string; id?: string;
          preset?: string; language?: string; code?: string; inputRef?: string; name?: string;
          kind?: string; trigger?: string; tags?: string[]; include_duplicates?: boolean;
          knowledge_base_id?: string; source_url?: string; folder_path?: string;
          pattern?: string; glob?: string; depth?: number; max_results?: number;
          max_matches?: number; case_insensitive?: boolean; fixed_string?: boolean;
          max_lines?: number;
          filter_equals?: string; filter_contains?: string;
          filter_any_fields?: string; filter_any_value?: string; filter_json?: string;
          replace_existing?: boolean;
          old_string?: string; new_string?: string; replace_all?: boolean;
        };
        try {
          parsedArgs = JSON.parse(tc.arguments) as typeof parsedArgs;
        } catch {
          parsedArgs = {};
        }

        if (tc.name === "scrape_webpage" && parsedArgs.url) {
          send?.("status", { label: t(locale, "chat.statusToolScrape") });
          const tTool = Date.now();
          try {
          const result = await scrapeUrl(parsedArgs.url);
          if (result === null) {
            toolOutcome = outcomeError("scrape_webpage", `Failed to scrape ${parsedArgs.url}`, "Verify the URL is reachable. If it requires JS, use search_web instead.");
          } else {
            sources.push({
              url: result.url,
              title: result.title,
              snippet: result.content.slice(0, 200),
            });
            toolOutcome = outcomeOk("scrape_webpage", `<${result.url}>\n${result.title}\n${result.content.slice(0, SEARCH_RESULT_CONTENT_SLICE)}`);
          }
          } catch {
            toolOutcome = outcomeError("scrape_webpage", `Failed to scrape ${parsedArgs.url}`, "Verify the URL is reachable. If it requires JS, use search_web instead.");
          }
          logger.info("search-timing", "tool", { tool: "scrape_webpage", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "search_web" && parsedArgs.query) {
          send?.("status", { label: t(locale, "chat.statusToolSearch") });
          const tTool = Date.now();
          // Narrow once so nested callbacks see string (not string | undefined)
          const searchQuery = parsedArgs.query;
          try {
            const response = await searchWeb(
              searchQuery,
              searchMaxResults,
              timeRange,
              detectSearchLanguage(searchQuery),
            );
            const rankedToolResults = applyDomainQualityFilter(
              dedupeAndRankSearchResults(response.results),
            );
            for (const r of rankedToolResults) {
              sources.push({
                url: r.url,
                title: r.scrapeTitle || r.title,
                snippet: r.snippet,
              });
            }
            const rawContent = rankedToolResults
              .map((r) => {
                const body = r.scraped
                  ? sliceContentAroundQuery(r.content, searchQuery, SEARCH_RESULT_CONTENT_SLICE)
                  : r.snippet;
                return `<${r.url}>\n${r.scrapeTitle || r.title}\n${body}`;
              })
              .join("\n\n");
            if (!rawContent) {
              toolOutcome = outcomeEmpty("search_web", "No results found.", "Reformulate the query with different keywords, add a site: filter, or broaden the time range.");
            } else {
              // Summarize search results with the search model (thinking=none for speed).
              // On summarization failure, fall back to raw search results.
              try {
                const sModel = defaultSearchModel();
                const sEffort = searchThinkingEffort();
                toolOutcome = outcomeOk("search_web", await completeText(
                  llm,
                  sModel,
                  [
                    {
                      role: "system",
                      content: "You are a search result summarizer. Given web search results, extract the key facts and information relevant to the user's query. Be concise but preserve all important details, URLs, and sources. Output only the summarized findings in clear text.",
                    },
                    {
                      role: "user",
                      content: `Query: ${searchQuery}\n\nSearch results:\n${rawContent}`,
                    },
                  ],
                  { reasoningEffort: sEffort as OpenAI.ReasoningEffort | null },
                ));
              } catch {
                toolOutcome = outcomeOk("search_web", rawContent);
              }
            }
          } catch {
            toolOutcome = outcomeError("search_web", `Search failed for: ${searchQuery}`, "The search service may be down. Try a simpler query or use search_wikipedia for factual topics.");
          }
          logger.info("search-timing", "tool", { tool: "search_web", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "search_wikipedia" && parsedArgs.query) {
          send?.("status", { label: t(locale, "chat.statusWikiLooking") });
          const tTool = Date.now();
          try {
            const result = await searchWikipedia(parsedArgs.query);
            if (result) {
              sources.push({ url: result.url, title: result.title, snippet: result.description });
              toolOutcome = outcomeOk("search_wikipedia", `<${result.url}>\n${result.title}\n${result.description}\n${result.extract}`);
            } else {
              toolOutcome = outcomeEmpty("search_wikipedia", "No Wikipedia article found.", "Try a different entity name, or use search_web for broader coverage.");
            }
          } catch {
            toolOutcome = outcomeError("search_wikipedia", `Wikipedia lookup failed for: ${parsedArgs.query}`, "The Wikipedia API may be temporarily unavailable. Retry or use search_web instead.");
          }
          logger.info("search-timing", "tool", { tool: "search_wikipedia", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "read_file" && parsedArgs.path) {
          send?.("status", { label: t(locale, "chat.statusToolReadFile") });
          const tTool = Date.now();
          try {
            const result = await readWorkspaceFile(parsedArgs.path, userId);
            toolOutcome = result.startsWith("File is too large")
              ? { tool: "read_file", status: "partial", summary: "File too large, truncated", body: result, nextHint: "Use grep_content to search within the file instead of reading it fully." }
              : outcomeOk("read_file", result);
          } catch (err) {
            toolOutcome = outcomeError("read_file", `Failed to read file: ${err instanceof Error ? err.message : String(err)}`, "Verify the path. Use search_files with a glob pattern to locate the file if unsure.");
          }
          logger.info("search-timing", "tool", { tool: "read_file", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "write_file" && parsedArgs.path && parsedArgs.content !== undefined) {
          send?.("status", { label: t(locale, "chat.statusToolWriteFile") });
          const tTool = Date.now();
          try {
            const result = await writeWorkspaceFile(parsedArgs.path, parsedArgs.content, userId);
            toolOutcome = outcomeOk("write_file", result);
          } catch (err) {
            toolOutcome = outcomeError("write_file", `Failed to write file: ${err instanceof Error ? err.message : String(err)}`, "Check the path is within the workspace and the disk has space.");
          }
          logger.info("search-timing", "tool", { tool: "write_file", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "edit_file" && parsedArgs.path && parsedArgs.old_string !== undefined && parsedArgs.new_string !== undefined) {
          send?.("status", { label: t(locale, "chat.statusToolEditFile") });
          const tTool = Date.now();
          toolOutcome = await editFileInWorkspace({
            path: parsedArgs.path,
            oldString: parsedArgs.old_string,
            newString: parsedArgs.new_string,
            replaceAll: parsedArgs.replace_all === true,
            userId,
          });
          logger.info("search-timing", "tool", { tool: "edit_file", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "list_directory" && parsedArgs.path) {
          send?.("status", { label: t(locale, "chat.statusToolListDir") });
          const tTool = Date.now();
          try {
            const result = await listWorkspaceDirectory(parsedArgs.path, userId, {
              depth: typeof parsedArgs.depth === "number" ? parsedArgs.depth : undefined,
            });
            toolOutcome = result.startsWith("[LIST empty]")
              ? outcomeEmpty("list_directory", result, "The directory is empty. Try listing a parent or different path, or use search_files with a glob pattern.")
              : outcomeOk("list_directory", result);
          } catch (err) {
            toolOutcome = outcomeError("list_directory", `Failed to list directory: ${err instanceof Error ? err.message : String(err)}`, "Verify the path exists. Use search_files to find files by pattern instead of listing.");
          }
          logger.info("search-timing", "tool", { tool: "list_directory", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "search_files" && parsedArgs.pattern) {
          send?.("status", { label: t(locale, "chat.statusToolSearchFiles") });
          const tTool = Date.now();
          try {
            const result = await searchWorkspaceFiles(parsedArgs.pattern, userId, {
              path: parsedArgs.path,
              maxResults: typeof parsedArgs.max_results === "number" ? parsedArgs.max_results : undefined,
            });
            toolOutcome = result.startsWith("[SEARCH empty]")
              ? outcomeEmpty("search_files", result, "Broaden the glob pattern (e.g. '**/*.ts' instead of '*.ts'), or search a different subdirectory.")
              : outcomeOk("search_files", result);
          } catch (err) {
            toolOutcome = outcomeError("search_files", `Failed to search files: ${err instanceof Error ? err.message : String(err)}`, "Check the glob syntax. Use grep_content to search file contents instead.");
          }
          logger.info("search-timing", "tool", { tool: "search_files", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "grep_content" && parsedArgs.pattern) {
          send?.("status", { label: t(locale, "chat.statusToolGrepContent") });
          const tTool = Date.now();
          try {
            const result = await grepWorkspaceContent(parsedArgs.pattern, userId, {
              path: parsedArgs.path,
              glob: parsedArgs.glob,
              caseInsensitive: parsedArgs.case_insensitive,
              fixedString: parsedArgs.fixed_string === true,
              maxMatches: typeof parsedArgs.max_matches === "number" ? parsedArgs.max_matches : undefined,
            });
            toolOutcome = result.startsWith("[GREP empty]")
              ? outcomeEmpty("grep_content", result, "Broaden the regex or try a different path/glob. Use fixed_string=true for exact text.")
              : outcomeOk("grep_content", result);
          } catch (err) {
            toolOutcome = outcomeError("grep_content", `Failed to grep content: ${err instanceof Error ? err.message : String(err)}`, "Check the regex syntax. Use fixed_string=true to treat the pattern as literal text.");
          }
          logger.info("search-timing", "tool", { tool: "grep_content", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "run_command" && parsedArgs.command) {
          send?.("status", { label: t(locale, "chat.statusToolRunCommand") });
          const tTool = Date.now();
          try {
            const result = await runWorkspaceCommand(parsedArgs.command, userId);
            toolOutcome = result.startsWith("Blocked:")
              ? outcomeError("run_command", result, "Only whitelisted read-only commands are allowed (git status/log/diff, ls, cat, grep, find, wc, etc.).")
              : outcomeOk("run_command", result);
          } catch (err) {
            toolOutcome = outcomeError("run_command", `Command failed: ${err instanceof Error ? err.message : String(err)}`, "Check the command syntax. Only whitelisted read-only commands are allowed.");
          }
          logger.info("search-timing", "tool", { tool: "run_command", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "sandbox_run") {
          send?.("status", { label: t(locale, "chat.statusToolSandboxRun") });
          const tTool = Date.now();
          try {
            // runSandbox accepts unknown and validates via the policy gate.
            // Pass the full parsed args; never pass host paths through.
            const result = await runSandbox(parsedArgs, userId);
            // Mark the output as untrusted so the model treats stdout/stderr
            // as data, not instructions (Tier 1 light sanitize, spec §7.1).
            toolOutcome = outcomeOk("sandbox_run", "[sandbox untrusted output]\n" + JSON.stringify(result));
          } catch (err) {
            toolOutcome = outcomeError("sandbox_run", `Sandbox failed: ${err instanceof Error ? err.message : String(err)}`, "Check that Docker is available and the code is valid. Use write_file to persist output files.");
          }
          logger.info("search-timing", "tool", { tool: "sandbox_run", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "read_logs") {
          send?.("status", { label: t(locale, "chat.statusToolReadLogs") });
          const tTool = Date.now();
          try {
            const tailLines = typeof parsedArgs.tailLines === "number" ? parsedArgs.tailLines : 200;
            const minLevel = (parsedArgs.minLevel === "debug" || parsedArgs.minLevel === "info" || parsedArgs.minLevel === "warn" || parsedArgs.minLevel === "error") ? parsedArgs.minLevel : "info";
            const result = await readProcessLogs(tailLines, minLevel);
            toolOutcome = outcomeOk("read_logs", `[source: ${result.source}${result.containerId ? `, container: ${result.containerId}` : ""}${result.truncated ? ", truncated" : ""}]\n${result.lines}`);
          } catch (err) {
            toolOutcome = outcomeError("read_logs", `Failed to read logs: ${err instanceof Error ? err.message : String(err)}`, "The log source may be unavailable. Try a different tailLines or minLevel.");
          }
          logger.info("search-timing", "tool", { tool: "read_logs", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "todo_create" && parsedArgs.title) {
          send?.("status", { label: t(locale, "chat.statusToolTodoCreate") });
          const created = await createTodo(userId, {
            title: parsedArgs.title,
            description: parsedArgs.description,
            priority: parsedArgs.priority === "low" || parsedArgs.priority === "medium" || parsedArgs.priority === "high" ? parsedArgs.priority : undefined,
            dueAt: parsedArgs.due_at ? new Date(parsedArgs.due_at) : null,
            threadId: threadId ?? null,
          });
          toolOutcome = outcomeOk("todo_create", JSON.stringify(created));
        } else if (tc.name === "todo_list") {
          send?.("status", { label: t(locale, "chat.statusToolTodoList") });
          const status = parsedArgs.status === "pending" || parsedArgs.status === "in_progress" || parsedArgs.status === "completed" ? parsedArgs.status : undefined;
          const list = await listTodos(userId, status);
          toolOutcome = list.length === 0
            ? outcomeEmpty("todo_list", "No todos found.", "Create a todo with todo_create first, or set status to 'all'.")
            : outcomeOk("todo_list", JSON.stringify(list));
        } else if (tc.name === "todo_update" && parsedArgs.id) {
          send?.("status", { label: t(locale, "chat.statusToolTodoUpdate") });
          const updated = await updateTodo(userId, parsedArgs.id, {
            title: parsedArgs.title,
            description: parsedArgs.description,
            status: parsedArgs.status === "pending" || parsedArgs.status === "in_progress" || parsedArgs.status === "completed" ? parsedArgs.status : undefined,
            priority: parsedArgs.priority === "low" || parsedArgs.priority === "medium" || parsedArgs.priority === "high" ? parsedArgs.priority : undefined,
            dueAt: parsedArgs.due_at === null ? null : (parsedArgs.due_at ? new Date(parsedArgs.due_at) : undefined),
          });
          toolOutcome = updated
            ? outcomeOk("todo_update", JSON.stringify(updated))
            : outcomeError("todo_update", "Todo not found", "Call todo_list to see available todo ids.");
        } else if (tc.name === "todo_delete" && parsedArgs.id) {
          send?.("status", { label: t(locale, "chat.statusToolTodoDelete") });
          await deleteTodo(userId, parsedArgs.id);
          toolOutcome = outcomeOk("todo_delete", "Todo deleted");
        } else if (tc.name === "skill_list") {
          send?.("status", { label: t(locale, "chat.statusToolSkillList") });
          const skillStatus = parsedArgs.status === "active" || parsedArgs.status === "archived" ? parsedArgs.status : undefined;
          const includeDups = parsedArgs.include_duplicates === true;
          const list = await listSkills(userId, skillStatus, includeDups);
          toolOutcome = list.length === 0
            ? outcomeEmpty("skill_list", "No skills found.", "Create a skill with skill_create, or set status to 'all'.")
            : outcomeOk("skill_list", JSON.stringify(list));
        } else if (tc.name === "skill_create" && parsedArgs.name && parsedArgs.content) {
          send?.("status", { label: t(locale, "chat.statusToolSkillCreate") });
          try {
            const validKinds = ["workflow", "bugfix", "project_rule", "tool_usage", "coding_pattern", "debugging"] as const;
            const created = await createSkill(userId, {
              name: parsedArgs.name,
              content: parsedArgs.content,
              kind: parsedArgs.kind && (validKinds as readonly string[]).includes(parsedArgs.kind)
                ? parsedArgs.kind as typeof validKinds[number]
                : undefined,
              trigger: parsedArgs.trigger,
              tags: Array.isArray(parsedArgs.tags) ? parsedArgs.tags : undefined,
            });
            toolOutcome = "error" in created
              ? outcomeError("skill_create", "A skill with identical content already exists.", "Modify the content or update the existing skill with skill_update.")
              : outcomeOk("skill_create", JSON.stringify(created));
          } catch (err) {
            toolOutcome = outcomeError("skill_create", `Failed to create skill: ${err instanceof Error ? err.message : String(err)}`, "Check the skill name and content are valid.");
          }
        } else if (tc.name === "skill_update" && parsedArgs.id) {
          send?.("status", { label: t(locale, "chat.statusToolSkillUpdate") });
          const result = await updateSkillContent(parsedArgs.id, userId, {
            content: parsedArgs.content,
            name: parsedArgs.name,
            trigger: parsedArgs.trigger,
            tags: Array.isArray(parsedArgs.tags) ? parsedArgs.tags : undefined,
            status: parsedArgs.status === "active" || parsedArgs.status === "archived" ? parsedArgs.status : undefined,
          });
          if (!result) {
            toolOutcome = outcomeError("skill_update", "Skill not found", "Call skill_list to see available skill ids.");
          } else if ("error" in result) {
            toolOutcome = result.error === "embed_failed"
              ? outcomeError("skill_update", "Failed to update skill: embedding service unavailable.", "Retry later when the embedding service recovers.")
              : outcomeError("skill_update", "Skill was modified by another request. Please retry.", "Re-read the skill with skill_list and retry the update.");
          } else {
            toolOutcome = outcomeOk("skill_update", JSON.stringify(result));
          }
        } else if (tc.name === "skill_delete" && parsedArgs.id) {
          send?.("status", { label: t(locale, "chat.statusToolSkillDelete") });
          const deleted = await deleteSkill(userId, parsedArgs.id);
          toolOutcome = deleted
            ? outcomeOk("skill_delete", "Skill deleted")
            : outcomeError("skill_delete", "Skill not found", "Call skill_list to see available skill ids.");
        } else if (tc.name === "kb_create" && parsedArgs.name) {
          send?.("status", { label: t(locale, "chat.statusToolKbCreate") });
          const tTool = Date.now();
          try {
            const kb = await createKnowledgeBase(userId, parsedArgs.name, parsedArgs.description);
            toolOutcome = outcomeOk("kb_create", `Knowledge base created: ${kb.id} (${kb.name})`, `kb_id=${kb.id}`);
          } catch (err) {
            toolOutcome = outcomeError("kb_create", `Failed to create knowledge base: ${err instanceof Error ? err.message : String(err)}`, "Check the KB name is valid and the database is writable.");
          }
          logger.info("search-timing", "tool", { tool: "kb_create", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "kb_list") {
          send?.("status", { label: t(locale, "chat.statusToolKbList") });
          const tTool = Date.now();
          try {
            const kbs = await listKnowledgeBases(userId);
            toolOutcome = kbs.length === 0
              ? outcomeEmpty("kb_list", "No knowledge bases found.", "Create one with kb_create first.")
              : outcomeOk("kb_list", JSON.stringify(
                  kbs.map((kb) => ({
                    id: kb.id,
                    name: kb.name,
                    description: kb.description,
                    documentCount: kb.documentCount,
                    createdAt: kb.createdAt,
                  })),
                ));
          } catch (err) {
            toolOutcome = outcomeError("kb_list", `Failed to list knowledge bases: ${err instanceof Error ? err.message : String(err)}`, "The database may be temporarily unavailable.");
          }
          logger.info("search-timing", "tool", { tool: "kb_list", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "kb_delete" && parsedArgs.knowledge_base_id) {
          send?.("status", { label: t(locale, "chat.statusToolKbDelete") });
          const tTool = Date.now();
          try {
            const ok = await deleteKnowledgeBase(parsedArgs.knowledge_base_id, userId);
            toolOutcome = ok
              ? outcomeOk("kb_delete", `Knowledge base deleted: ${parsedArgs.knowledge_base_id}`)
              : outcomeError("kb_delete", `Knowledge base not found or not owned: ${parsedArgs.knowledge_base_id}`, "Call kb_list to verify the kb_id.");
          } catch (err) {
            toolOutcome = outcomeError("kb_delete", `Failed to delete knowledge base: ${err instanceof Error ? err.message : String(err)}`, "The database may be temporarily unavailable.");
          }
          logger.info("search-timing", "tool", { tool: "kb_delete", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "kb_ingest" && parsedArgs.knowledge_base_id && parsedArgs.title) {
          send?.("status", { label: t(locale, "chat.statusToolKbIngest") });
          const tTool = Date.now();
          try {
            let content = parsedArgs.content ?? "";
            let sourceUrl: string | undefined;
            let sourceType: "text" | "url" = "text";
            if (parsedArgs.source_url) {
              sourceType = "url";
              sourceUrl = parsedArgs.source_url;
              const scraped = await scrapeUrl(sourceUrl);
              if (!scraped) {
                toolOutcome = outcomeError("kb_ingest", "Failed to scrape URL (scraper service unavailable)", "Provide content directly instead of a source_url, or retry later.");
              } else {
                content = scraped.content;
              }
            }
            if (!content) {
              if (!toolOutcome) toolOutcome = outcomeError("kb_ingest", "No content to ingest (provide content or a valid source_url)", "Pass the 'content' field or a valid 'source_url'.");
            } else {
              const result = await ingestDocument(parsedArgs.knowledge_base_id, {
                title: parsedArgs.title,
                sourceType,
                sourceUrl,
                content,
              }, userId);
              toolOutcome = result.cached
                ? outcomeOk("kb_ingest", `Document already exists (cached): ${result.id}`)
                : outcomeOk("kb_ingest", `Document ingested: ${result.id} (${result.chunkCount} chunks)`);
            }
          } catch (err) {
            toolOutcome = outcomeError("kb_ingest", `Failed to ingest document: ${err instanceof Error ? err.message : String(err)}`, "Check the kb_id with kb_list and ensure the content is valid text.");
          }
          logger.info("search-timing", "tool", { tool: "kb_ingest", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "kb_search" && parsedArgs.knowledge_base_id && parsedArgs.query) {
          send?.("status", { label: t(locale, "chat.statusToolKbSearch") });
          const tTool = Date.now();
          try {
            // userId ownership verified in searchKnowledgeBases via JOIN on knowledge_bases.user_id
            // Hybrid search (vector + keyword + speaker re-rank); return more text for accuracy.
            const results = await searchKnowledgeBases(
              parsedArgs.query,
              [parsedArgs.knowledge_base_id],
              userId,
              8,
              0.22,
            );
            toolOutcome =
              results.length === 0
                ? outcomeEmpty("kb_search", "No results found.", "Reformulate the query with different keywords, or verify the kb_id with kb_list.")
                : outcomeOk("kb_search", JSON.stringify(
                    results.map((r) => ({
                      title: r.title,
                      speaker: r.title.split("|")[0]?.trim() ?? r.title,
                      similarity: r.similarity,
                      text: r.text.slice(0, 400),
                    })),
                  ));
          } catch (err) {
            toolOutcome = outcomeError("kb_search", `Failed to search knowledge base: ${err instanceof Error ? err.message : String(err)}`, "Check the kb_id with kb_list and ensure the embedding service is available.");
          }
          logger.info("search-timing", "tool", { tool: "kb_search", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "kb_ingest_folder" && parsedArgs.knowledge_base_id && parsedArgs.folder_path) {
          send?.("status", { label: t(locale, "chat.statusToolKbIngestFolder") });
          const tTool = Date.now();
          try {
            const result = await ingestFolder(parsedArgs.knowledge_base_id, parsedArgs.folder_path, userId);
            let folderBody = `Ingested ${result.ingested} file(s), skipped ${result.skipped} empty file(s)${result.errors.length > 0 ? `, ${result.errors.length} error(s)` : ""}`;
            if (result.errors.length > 0) {
              folderBody += `\nErrors:\n${result.errors.slice(0, 5).join("\n")}${result.errors.length > 5 ? `\n... and ${result.errors.length - 5} more` : ""}`;
            }
            toolOutcome = outcomeOk("kb_ingest_folder", folderBody);
          } catch (err) {
            toolOutcome = outcomeError("kb_ingest_folder", `Failed to ingest folder: ${err instanceof Error ? err.message : String(err)}`, "Verify the folder_path exists in the workspace and the kb_id is valid.");
          }
          logger.info("search-timing", "tool", { tool: "kb_ingest_folder", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "kb_ingest_jsonl" && parsedArgs.knowledge_base_id && parsedArgs.path) {
          send?.("status", { label: t(locale, "chat.statusToolKbIngestJsonl") });
          const tTool = Date.now();
          try {
            const filter = buildJsonlFilterFromToolArgs(parsedArgs);
            const result = await ingestJsonlFile(
              parsedArgs.knowledge_base_id,
              parsedArgs.path,
              userId,
              {
                maxLines:
                  typeof parsedArgs.max_lines === "number" ? parsedArgs.max_lines : undefined,
                filter,
                onProgress: (done, total, phase) => {
                  // Keep SSE alive and show progress so the UI does not look hung
                  // while thousands of chunks are embedded.
                  if (phase === "embed") {
                    send?.("status", {
                      label: t(locale, "chat.statusToolKbEmbedProgress", {
                        done: String(done),
                        total: String(total),
                      }),
                    });
                  } else if (phase === "write" && (done % 100 === 0 || done === total)) {
                    send?.("status", {
                      label: t(locale, "chat.statusToolKbWriteProgress", {
                        done: String(done),
                        total: String(total),
                      }),
                    });
                  }
                },
              },
            );
            let jsonlBody =
              `JSONL ingest complete for ${parsedArgs.path}: ` +
              `ingested=${result.ingested}, cached=${result.cached}, skipped=${result.skipped}, errors=${result.errors.length}` +
              (filter ? `\nfilter applied` : "") +
              (result.titles.length > 0 ? `\nSample titles: ${result.titles.join(", ")}` : "");
            if (result.errors.length > 0) {
              jsonlBody +=
                `\nErrors:\n${result.errors.slice(0, 8).join("\n")}` +
                (result.errors.length > 8 ? `\n... and ${result.errors.length - 8} more` : "");
            }
            toolOutcome = outcomeOk("kb_ingest_jsonl", jsonlBody);
          } catch (err) {
            toolOutcome = outcomeError("kb_ingest_jsonl", `Failed to ingest JSONL: ${err instanceof Error ? err.message : String(err)}`, "Verify the JSONL path and kb_id. Check that the file has one JSON object per line with content/text.");
          }
          logger.info("search-timing", "tool", { tool: "kb_ingest_jsonl", round: rounds, duration: Date.now() - tTool });
        } else if (tc.name === "kb_from_jsonl" && parsedArgs.name && parsedArgs.path) {
          send?.("status", { label: t(locale, "chat.statusToolKbFromJsonl") });
          const tTool = Date.now();
          try {
            const filter = buildJsonlFilterFromToolArgs(parsedArgs);
            const result = await createKnowledgeBaseFromJsonl(userId, {
              name: parsedArgs.name,
              description: parsedArgs.description,
              path: parsedArgs.path,
              filter,
              maxLines:
                typeof parsedArgs.max_lines === "number" ? parsedArgs.max_lines : undefined,
              replaceExisting: parsedArgs.replace_existing !== false,
              onProgress: (done, total, phase) => {
                if (phase === "embed") {
                  send?.("status", {
                    label: t(locale, "chat.statusToolKbEmbedProgress", {
                      done: String(done),
                      total: String(total),
                    }),
                  });
                } else if (phase === "write" && (done % 100 === 0 || done === total)) {
                  send?.("status", {
                    label: t(locale, "chat.statusToolKbWriteProgress", {
                      done: String(done),
                      total: String(total),
                    }),
                  });
                }
              },
            });
            let fromJsonlBody =
              `KB created from JSONL.\n` +
              `kb_id=${result.kbId}\n` +
              `kb_name=${result.kbName}\n` +
              `path=${parsedArgs.path}\n` +
              `filter=${result.filterDescription}\n` +
              `ingest: ingested=${result.ingest.ingested} cached=${result.ingest.cached} skipped=${result.ingest.skipped} errors=${result.ingest.errors.length}\n` +
              `deleted_same_name_kbs=${result.deletedSameNameKbIds.length}` +
              (result.ingest.titles.length
                ? `\nSample titles: ${result.ingest.titles.join(", ")}`
                : "");
            if (result.ingest.errors.length > 0) {
              fromJsonlBody +=
                `\nErrors:\n${result.ingest.errors.slice(0, 8).join("\n")}` +
                (result.ingest.errors.length > 8
                  ? `\n... and ${result.ingest.errors.length - 8} more`
                  : "");
            }
            toolOutcome = outcomeOk("kb_from_jsonl", fromJsonlBody, `kb_id=${result.kbId}`);
          } catch (err) {
            toolOutcome = outcomeError("kb_from_jsonl", `Failed kb_from_jsonl: ${err instanceof Error ? err.message : String(err)}`, "Verify the JSONL path exists and has valid JSON lines with content/text.");
          }
          logger.info("search-timing", "tool", { tool: "kb_from_jsonl", round: rounds, duration: Date.now() - tTool });
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
                toolOutcome = outcomeOk(tc.name, await callMcpTool(conn, parsed.toolName, mcpArgs));
              } catch {
                toolOutcome = outcomeError(tc.name, `MCP tool ${tc.name} failed`, "The MCP server may be disconnected. Check the connection status and retry.");
              }
            } else {
              toolOutcome = outcomeError(tc.name, `MCP server "${parsed.serverName}" not connected`, "Reconnect the MCP server or verify it is enabled for this thread.");
            }
          } else {
            toolOutcome = outcomeError(tc.name, `Unknown tool: ${tc.name}`, "The tool name format is invalid.");
          }
        } else if (connectionRows && connectionRows.length > 0) {
          // Connection tool: resolve provider by tool-name prefix (notion_, gmail_, etc.)
          // and find the matching enabled connection for that provider.
          const provider = resolveProviderFromToolName(tc.name);
          if (!provider) {
            toolOutcome = outcomeError(tc.name, `Unknown tool: ${tc.name}`, "The tool name does not match any known provider.");
          } else {
            const conn = connectionRows.find((c) => c.provider === provider);
            if (!conn) {
              toolOutcome = outcomeError(tc.name, `No active connection for provider: ${provider}`, "Authorize the connection in the Connections menu first.");
            } else {
              send?.("status", { label: t(locale, "chat.statusToolConnection", { tool: tc.name }) });
              try {
                let connArgs: Record<string, unknown>;
                try {
                  connArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
                } catch {
                  connArgs = {};
                }
                const result = await dispatchConnectionTool(conn, tc.name, connArgs);
                toolOutcome = outcomeOk(tc.name, result.content);
                // Persist refreshed token: access-only allowed; refresh + expiry when present.
                if (result.newAccessToken) {
                  try {
                    const updates: Record<string, unknown> = {
                      accessToken: result.newAccessToken,
                      updatedAt: new Date(),
                    };
                    if (result.newRefreshToken) updates.refreshToken = result.newRefreshToken;
                    if (result.newExpiresAt) updates.expiresAt = result.newExpiresAt;
                    await db.update(connections)
                      .set(updates)
                      .where(eq(connections.id, conn.id));
                  } catch {
                    // Ignore persistence errors — will be refreshed again on next call
                  }
                }
              } catch {
                toolOutcome = outcomeError(tc.name, `Connection tool ${tc.name} failed`, "The connection may need re-authorization. Check the Connections menu.");
              }
            }
          }
        } else {
          toolOutcome = outcomeError(tc.name, `Unknown tool: ${tc.name}`, "This tool is not available in the current configuration.");
        }

        // Convert the structured outcome into the string the model sees.
        toolContent = toolOutcome
          ? formatToolOutcomeForModel(toolOutcome)
          : `Unknown tool: ${tc.name}`;

        recordToolResult(toolTranscript, {
          name: tc.name,
          content: toolContent,
          round: rounds,
        });
        if (toolOutcome) recordToolOutcome(loopGuardState, tc, toolOutcome);

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

      // Keep grounding near the latest tool results so the next completion
      // is constrained to quote/observe instead of narrating unfounded checks.
      currentMessages = [
        ...currentMessages,
        { role: "system" as const, content: TOOL_GROUNDING_REMINDER },
      ];

      if (rounds >= MAX_TOOL_ROUNDS) {
        send?.("status", { label: t(locale, "chat.statusSearchLimit") });
      }

      // Re-stream (next round)
    } catch (err) {
      clearTimeout(ttftTimer ?? undefined);
      // TTFT timeout: no delta received, abort fired, fallback configured, first round.
      // Covers both connection-phase abort (create() throws) and stream-phase abort
      // (for-await throws). firstDeltaReceived is shared across both phases.
      if (
        !firstDeltaReceived &&
        fallbackEnabled &&
        !fallbackRetried &&
        rounds === 0 &&
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("abort"))
      ) {
        fallbackRetried = true;
        modelToUse = fbModel!;
        // Recompute reasoning params for the fallback model
        reasoningEffort = thinkingEffort && (await getReasoningLevels(modelToUse)).includes(thinkingEffort)
          ? thinkingEffort
          : await getDefaultReasoningEffort(modelToUse);
        disableReasoningParams = await buildDisableReasoningParams(modelToUse);
        onModelFallback!(modelToUse);
        send?.("status", { label: t(locale, "chat.statusModelFallback", { model: modelToUse }) });
        logger.info("chat", "ttft-fallback", { from: model, to: modelToUse, timeoutMs: fbTimeoutMs });
        // Reset accumulator state and retry the same round
        continue;
      }
      throw err;
    }
  }

  // ── Agent hooks (OMP-style): always leave a user-visible body ──
  // 1) Force one tools-off LLM report when content is still empty/tiny
  // 2) If the model still only thinks, auto-report from tool transcript
  const hookArgs = {
    emittedContentChars,
    toolRounds: rounds,
    toolResultCount: toolTranscript.length,
  };

  if (shouldForceFinalAnswer(hookArgs)) {
    logger.warn("chat", "hook-force-final-answer", {
      model: modelToUse,
      toolRounds: rounds,
      emittedContentChars,
      toolResults: toolTranscript.length,
    });
    send?.("status", { label: t(locale, "chat.statusFinalAnswerRequired") });
    currentMessages = [
      ...currentMessages,
      { role: "system" as const, content: buildForcedReportPrompt(toolTranscript) },
    ];
    try {
      const recovery = await llm.chat.completions.create({
        model: modelToUse,
        messages: currentMessages,
        stream: true,
        ...(reasoningEffort === "none"
          ? disableReasoningParams
          : reasoningEffort && (await getReasoningLevels(modelToUse)).includes(reasoningEffort)
            ? { reasoning_effort: reasoningEffort }
            : {}),
        // No tools — answer only (hook-enforced).
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);
      for await (const chunk of recovery) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta as Record<string, unknown> | undefined;
        const reasoningDelta =
          delta && typeof delta === "object" && "reasoning_content" in delta && typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : undefined;
        if (reasoningDelta) onReasoning(reasoningDelta);
        const contentDelta = choice.delta?.content;
        if (contentDelta) emitContent(contentDelta);
      }
    } catch (err) {
      logger.error("chat", "hook-force-final-answer-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Deterministic last resort: never end on thinking-only / empty bubble after tools
  // (or completely empty turns). Uses updated emittedContentChars after LLM recovery.
  if (
    shouldForceFinalAnswer({
      emittedContentChars,
      toolRounds: rounds,
      toolResultCount: toolTranscript.length,
    })
  ) {
    const auto = formatAutoUserReport({
      locale: locale === "ja" ? "ja" : "en",
      tools: toolTranscript,
      toolRounds: rounds,
    });
    emitContent(auto);
    logger.warn("chat", "hook-auto-user-report", {
      model: modelToUse,
      toolRounds: rounds,
      toolResults: toolTranscript.length,
      reportChars: auto.length,
    });
  }

  logger.info("chat", "llm-stream-end", {
    model: modelToUse,
    duration: Date.now() - llmStreamStartedAt,
    emittedContentChars,
    toolRounds: rounds,
    toolResults: toolTranscript.length,
  });
}
