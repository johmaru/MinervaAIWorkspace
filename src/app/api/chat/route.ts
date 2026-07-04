import { and, asc, eq, inArray } from "drizzle-orm";
import type OpenAI from "openai";
import { createLLM, defaultModel, defaultSearchModel, getReasoningLevels, getDefaultReasoningEffort, availableModels } from "@/lib/llm";
import { db } from "@/db";
import { messages, threads, users, mcpServers, connections, globalInstructions } from "@/db/schema";
import { getRequestLocale, t } from "@/lib/i18n";
import { scrapeUrl, searchWeb } from "@/lib/scraper";
import type { SourceInfo } from "@/lib/scraper";
import { extractUrls } from "@/lib/urlExtract";
import { decideSearch } from "@/lib/searchDecision";
import { probeToolSupport, warmupToolProbe } from "@/lib/toolProbe";
import type { ToolSupport } from "@/lib/toolProbe";
import { buildMemoryContext } from "@/lib/memoryStore";
import { buildSkillContext } from "@/lib/skillStore";
import { generateMemories } from "@/lib/memory";
import { generateSkillFromConversation } from "@/lib/skillGenerator";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// プロセス起動時にバックグラウンドでツールプローブを開始し、
// 初回チャットリクエスト時の probeToolSupport 遅延（~750ms）を隠す。
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

  const mode = body.mode ?? "send";
  const prepared = await prepareTurn(body, mode, thread, allMessages);
  if ("error" in prepared) return new Response(prepared.error, { status: prepared.status });

  const llm = createLLM();
  const finalModel = body.model ?? thread.model ?? defaultModel();
  // グローバルシステムインストラクション解決。
  // 優先順位: スレッド上書き > ユーザー既定。両方 null なら body.systemPrompt へ。
  let resolvedGlobalInstruction: string | null = null;
  const threadInstrId = thread.globalInstructionId ?? null;
  const [userRow] = await db
    .select({ activeInstructionId: users.activeInstructionId })
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
  // 優先順位: スレッド個別 systemPrompt > グローバル(スレッド上書き or ユーザー既定) > body
  const systemContent = thread.systemPrompt ?? resolvedGlobalInstruction ?? body.systemPrompt;

  // ツールプローブを早期開始し、ストリーム内の並列処理とオーバーラップさせる。
  // warmupToolProbe() がモジュール読み込み時にプローブを開始済みだが、
  // まだ完了していない場合に備えてここでも開始（キャッシュ済みなら即座に解決）。
  // rapid モード・dual モードでは使用しないが、プローブ自体は無害（キャッシュされる）。
  const toolSupportPromise: Promise<ToolSupport | null> = body.rapid
    ? Promise.resolve(null)
    : probeToolSupport(llm, finalModel).catch(() => null);

  // ストリーム完了を待つ Promise。after() コールバックがリクエストコンテキスト内で
  // generateMemories を実行するため、ストリーム完了後に内容を引き渡す。
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
        // プリストーム処理を並列実行し、first-token レイテンシを削減。
        // 各 build* は .catch(() => null) で包み、1つの失敗が他へ波及しないよう分離。
        // rapid モードは全スキップ（null）。
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
                }).catch((err) => {
                  console.error("[chat] buildSearchContext failed:", err);
                  return null;
                }),
                buildUrlContext({
                  content: prepared.content,
                  send,
                }).catch((err) => {
                  console.error("[chat] buildUrlContext failed:", err);
                  return null;
                }),
                buildMemoryContext({
                  content: prepared.content,
                  thread,
                }).catch((err) => {
                  console.error("[chat] buildMemoryContext failed:", err);
                  return null;
                }),
                buildSkillContext({
                  content: prepared.content,
                  userId: user.id,
                }).catch((err) => {
                  console.error("[chat] buildSkillContext failed:", err);
                  return null;
                }),
              ]);

        // MCP サーバー接続: スレッドで有効化されたサーバーに接続し、ツールを取得。
        // 接続失敗時はスキップし、チャットは継続（非ブロッキング）。
        // ライフサイクルはリクエスト内で完結し、finally で close する。
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
            console.error("[mcp] failed to load MCP servers:", err);
          }
        }

        // コネクション読み込み: スレッドで有効化されたコネクションのツールを取得。
        // MCP と異なりステートレスな HTTP API のため接続ハンドル不要。
        // 失敗時はスキップし、チャットは継続（非ブロッキング）。
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
            console.error("[connections] failed to load connections:", err);
          }
        }

        const finalMessages = buildFinalMessages({
          systemContent,
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
          });
        } else {
          if (body.rapid) {
            // rapid モード: ツール使用プローブ・MCP・接続ツールをすべてスキップし、
            // 純粋な LLM 即時回答のみ行う。
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
            });
          } else {
            // 関数呼び出し（ツール使用）プローブ: モデルがツール使用をサポートするか判定。
            // サポート時はストリーディング中に自律的に検索/スクレイプを実行。
            // 非サポート時は decideSearch ルーター方式（buildSearchContext）にフォールバック。
            // プローブは POST 本体で早期開始済み（warmupToolProbe + 早期呼び出し）。
            // ここでは結果を待つだけ（並列処理とオーバーラップしてレイテンシ隠蔽）。
            const toolSupport: ToolSupport | null = await toolSupportPromise;
            // ツール使用モード時は事前検索のsystemメッセージを除外:
            // 「検索完了・再検索禁止」メッセージがLLMのツール呼び出し結果の参照を阻害するため。
            const effectiveMessages = toolSupport?.supported
              ? buildFinalMessages({
                  systemContent,
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
              connectionRows,
              timeRange: body.timeRange,
            });
          }
        }

        // GLM-5.2 等のツール非対応モデルがツール呼び出し構文をテキストとして
        // 出力し、そこで生成を停止する問題への対処。
        // 検出時は構文を除去し、続行プロンプトで再生成する（最大1回）。
        if (hasToolCallMarkup(assistantContent)) {
          send("status", { label: "検索結果に基づいて回答を生成しています。" });
          assistantContent = sanitizeToolCallMarkup(assistantContent);
          // クライアントの表示内容をサニタイズ後の内容で置換。
          // ストリーミング中に送信された tool-call マークアップを UI から除去する。
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
      } finally {
        await db
          .update(threads)
          .set({ updatedAt: new Date() })
          .where(eq(threads.id, body.threadId));

        // ストリーム完了内容を after() コールバックへ引き渡す。
        streamResult.assistantContent = assistantContent;

        // MCP 接続を閉じる（stdio 子プロセスの終了を含む）。
        for (const conn of mcpConnections) {
          try { await conn.client.close(); } catch { /* ignore close errors */ }
        }

        // ストリームを即座に閉じる（クライアントの isStreaming を下げる）。
        controller.close();

        // after() コールバックに完了を通知。
        resolveStream();
      }
    },
  });

  // 記憶生成: after() で HTTP レスポンス完遂後にバックグラウンド実行。
  // after() はリクエストコンテキスト内（POST 本体）で呼ぶ必要がある。
  // ReadableStream の start() 内で呼ぶとリクエストコンテキストが失われ、
  // waitUntil が機能せずコールバックが実行されない。
  // done 送信後に close しているため、クライアント UX はブロックしない。
  // after() が Next.js の waitUntil を使うため、close 後もプロセスは維持される。
  // エラーは握りつぶす（ストリーム既に完了済み、ログのみ）。
  after(async () => {
    await streamDone;
    if (!streamResult.assistantContent) return;
    // ラピッドモード: 記憶・スキル生成をスキップし、即座に終了する。
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
      );
    } catch (err) {
      console.error("[memory] generation failed:", err);
    }

    // スキル保存トリガー検出: ユーザーが「スキルで保存」「save as skill」等を要求
    if (/(スキルで保存|スキルとして保存|save\s+as\s+skill)/i.test(prepared.content)) {
      try {
        await generateSkillFromConversation(body.threadId, user.id, llm, finalModel);
      } catch (err) {
        console.error("[skill] generation failed:", err);
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
 * ユーザー発言に含まれる URL をスクレイプし、コンテキストとして注入する。
 *
 * - extractUrls で URL 抽出（上限10件、重複排除）
 * - 各 URL を scrapeUrl で並列スクレイプ（1件失敗でも他は継続: Promise.allSettled）
 * - 成功結果を system message として構築
 * - 全件失敗/0件 → null（何もしない）
 * - SSE 進捗: status → sources
 */
async function buildUrlContext({
  content,
  send,
}: {
  content: string;
  send: StreamSend;
}): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam | null> {
  const urls = extractUrls(content);
  if (urls.length === 0) return null;

  if (urls.length >= 10) {
    send("status", { label: "最初の10件のURLを取得します。" });
  } else {
    send("status", { label: "URLの内容を取得しています。" });
  }

  const settled = await Promise.allSettled(urls.map((u) => scrapeUrl(u)));

  const sources: SourceInfo[] = [];
  const blocks: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const r = settled[i];
    if (r.status !== "fulfilled") continue;
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
}: {
  content: string;
  llm: OpenAI;
  history: DbMessage[];
  send: StreamSend;
  timeRange?: "day" | "week" | "month" | "year";
}): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam | null> {
  const tTotal = Date.now();
  const searchModel = defaultSearchModel();
  const tDecide = Date.now();
  const decision = await decideSearch(
    content,
    searchModel,
    history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content })),
  );
  console.log(`[search-timing] decideSearch duration=${Date.now() - tDecide}ms needsSearch=${decision.needsSearch} queries=${decision.queries.length}`);

  if (!decision.needsSearch || decision.queries.length === 0) {
    console.log(`[search-timing] buildSearchContext total=${Date.now() - tTotal}ms (no search)`);
    return null;
  }

  send("status", { label: decision.userNotice ?? "最新情報を確認するね。" });

  const maxResults = Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3;
  const maxRounds = Math.min(5, Math.max(1, Number(process.env.WEB_SEARCH_MAX_ROUNDS) || 2));
  const allSources: SourceInfo[] = [];
  const allResults: { url: string; title: string; snippet: string; content: string }[] = [];

  const queries = decision.queries.slice(0, maxRounds);
  // クエリを並列実行してレイテンシを短縮（直列だと最大 maxRounds 倍かかる）
  const tParallel = Date.now();
  const queryResults = await Promise.all(
    queries.map(async (query, qi) => {
      const tQuery = Date.now();
      try {
        const response = await searchWeb(query, maxResults, timeRange);
        console.log(`[search-timing] query ${qi + 1}/${queries.length} duration=${Date.now() - tQuery}ms results=${response.results.length}`);
        return response;
      } catch {
        console.log(`[search-timing] query ${qi + 1}/${queries.length} duration=${Date.now() - tQuery}ms results=0 (error)`);
        return null;
      }
    }),
  );
  console.log(`[search-timing] all queries parallel duration=${Date.now() - tParallel}ms count=${queries.length}`);
  for (const response of queryResults) {
    if (!response) continue;
    for (const r of response.results) {
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
    send("status", { label: "Web検索で結果が見つかりませんでした（検索エンジンが応答していない可能性があります）。トレーニングデータで回答します。" });
    // このメッセージは tool 非対応モデルにのみ到達する（tool 対応モデルは
    // effectiveMessages で searchContextMessage が除外され、自律的に検索する）。
    // 検索失敗を伝えてトレーニングデータで回答させ、情報が取得できなかったことを
    // 明示させる。null を返すと検索未実行として扱われ、情報欠落の認知も消える。
    console.log(`[search-timing] buildSearchContext total=${Date.now() - tTotal}ms (no results)`);
    return {
      role: "system",
      content: "Web search was attempted but returned no results. Answer from your training data and acknowledge that you could not retrieve current information.",
    };
  }

  // 検索結果を検索専用モデルで要約してから system メッセージにする。
  // 要約失敗時は生 JSON にフォールバック。
  // max_tokens で出力を制限し、要約の生成時間を抑える。
  const summarizeMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "Summarize the web search results into a concise factual briefing (max 500 words). Preserve key facts, numbers, dates, and source URLs. Do not add speculation. Answer in the user's language.",
    },
    {
      role: "user",
      content: `User question: ${content}\n\nSearch results:\n${JSON.stringify(allResults, null, 2)}`,
    },
  ];

  let summary = "";
  const tSummarize = Date.now();
  try {
    summary = await completeText(llm, searchModel, summarizeMessages, { maxTokens: 800, reasoningEffort: "none" });
  } catch {
    // 要約失敗時は生 JSON を使う
  }
  console.log(`[search-timing] summarize duration=${Date.now() - tSummarize}ms chars=${summary.length}`);
  const contextContent = summary || JSON.stringify(allResults, null, 2);

  console.log(`[search-timing] buildSearchContext total=${Date.now() - tTotal}ms`);
  return {
    role: "system",
    content: `Web search has already been completed. The results are provided below. Do NOT attempt to search or scrape again — do not output any tool-call commands. Answer the user's question directly using only these results.\n\nWeb search results:\n${contextContent}`,
  };
}
/**
 * プロンプト先頭に注入する環境コンテキスト（現在日時 + 実行環境）を構築。
 *
 * - HOST_OS env があればそれを使用（GUI で上書き可能）
 * - 未設定時は /proc/version からホストOS を自動検出:
 *   - "microsoft" or "WSL" を含む → "Windows"（WSL2 上の Docker Desktop）
 *   - "Darwin" を含む → "macOS"
 *   - それ以外 → "Linux"
 * - アーキテクチャは process.arch（x64 / arm64 等）
 * - タイムゾーンは TZ env（未設定時は Asia/Tokyo）
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
  history,
  content,
  searchContextMessage,
  urlContextMessage,
  skillMessage,
  memoryMessage,
}: {
  systemContent?: string | null;
  history: DbMessage[];
  content: string;
  searchContextMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam | null;
  urlContextMessage?: OpenAI.Chat.Completions.ChatCompletionMessageParam | null;
  skillMessage?: { role: "system"; content: string } | null;
  memoryMessage?: { role: "system"; content: string } | null;
}): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    { role: "system" as const, content: getEnvContext() },
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
}: {
  llm: OpenAI;
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  finalModel: string;
  thread: typeof threads.$inferSelect;
  send: StreamSend;
}): Promise<{ trace: DualTrace; finalMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] }> {
  const { modelA, modelB } = await resolveDualModels(thread, finalModel);

  send("status", { label: `モデルA（${modelA}）が回答中…` });
  const answerA = await completeText(llm, modelA, withDualInstruction(baseMessages, "You are model A. Give your best independent answer."));

  send("status", { label: `モデルB（${modelB}）が回答中…` });
  const answerB = await completeText(llm, modelB, withDualInstruction(baseMessages, "You are model B. Give your best independent answer."));

  if (thread.dualStrategy === "debate") {
    const debateTurns = await runDebateTurns({ llm, baseMessages, modelA, modelB, answerA, answerB, rounds: thread.dualDebateRounds, send });
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

  send("status", { label: "モデルAがモデルBの回答をレビュー中…" });
  const reviewA = await completeText(llm, modelA, [
    ...baseMessages,
    { role: "assistant", content: `Model A answer:\n${answerA}` },
    { role: "assistant", content: `Model B answer:\n${answerB}` },
    { role: "user", content: "Review Model B's answer. Identify strengths, gaps, and corrections. Be concise." },
  ]);

  send("status", { label: "モデルBがモデルAの回答をレビュー中…" });
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
}: {
  llm: OpenAI;
  baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  modelA: string;
  modelB: string;
  answerA: string;
  answerB: string;
  rounds: number;
  send: StreamSend;
}): Promise<{ speaker: "A" | "B"; model: string; content: string }[]> {
  const debateTurns: { speaker: "A" | "B"; model: string; content: string }[] = [];
  const clampedRounds = Math.min(5, Math.max(1, Math.trunc(rounds || 2)));

  for (let round = 1; round <= clampedRounds; round++) {
    send("status", { label: `デュアルモデル議論中… ${round}/${clampedRounds}` });
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
  options?: { maxTokens?: number; reasoningEffort?: OpenAI.ReasoningEffort | null },
): Promise<string> {
  const completion = await llm.chat.completions.create({
    model,
    messages: messagesForModel,
    stream: false,
    ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
  });
  return completion.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * ストリーミング完了用のツール定義。
 * probeToolSupport で supported:true の場合のみ使用される。
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
}) {
  const thinkingEffort = process.env.THINKING_EFFORT;
  const validLevels = await getReasoningLevels(model);
  const reasoningEffort =
    thinkingEffort && validLevels.includes(thinkingEffort)
      ? thinkingEffort
      : await getDefaultReasoningEffort(model);

  const useTools = toolSupport?.supported === true && send !== undefined;
  const searchMaxResults = Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3;

  let currentMessages = messagesForModel;
  let rounds = 0;

  // ツール使用モード: ストリーミング中に tool_calls を検知したら
 // ツールを実行し、結果を tool role メッセージとして追加して再ストリーミング。
  // 最大 MAX_TOOL_ROUNDS 回まで。超えたら残りはツール無しで回答継続。
  while (true) {
    const useToolsThisRound = useTools && rounds < MAX_TOOL_ROUNDS;

    const completion = await llm.chat.completions.create({
      model,
      messages: currentMessages,
      stream: true,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(useToolsThisRound
        ? { tools: [...STREAM_TOOLS, ...(extraTools ?? [])], tool_choice: "auto" }
        : {}),
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

    // ストリーミング中に tool_calls の delta を蓄積する。
    // OpenAI のストリーミング形式では tool_calls が分割されて届くため、
    // index ごとに結合する。
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

      // tool_calls の delta を蓄積
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
      // ツール呼び出しなし、または上限超過でツール無しラウンド → 完了
      break;
    }

    rounds++;

    // ツール呼び出しを実行
    const toolCalls = Object.values(toolCallAccumulator).filter((tc) => tc.name);

    // assistant メッセージ（tool_calls 含む）を履歴に追加
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

    // 各ツール呼び出しを実行し、結果を tool role メッセージとして追加
    for (const tc of toolCalls) {
      let toolContent: string;
      let parsedArgs: { url?: string; query?: string };
      try {
        parsedArgs = JSON.parse(tc.arguments) as { url?: string; query?: string };
      } catch {
        parsedArgs = {};
      }

      if (tc.name === "scrape_webpage" && parsedArgs.url) {
        send?.("status", { label: "URLの内容を取得しています。" });
        const tTool = Date.now();
        try {
          const result = await scrapeUrl(parsedArgs.url);
          sources.push({
            url: result.url,
            title: result.title,
            snippet: result.content.slice(0, 200),
          });
          toolContent = `<${result.url}>\n${result.title}\n${result.content.slice(0, SEARCH_RESULT_CONTENT_SLICE)}`;
        } catch {
          toolContent = `Failed to scrape ${parsedArgs.url}`;
        }
        console.log(`[search-timing] tool scrape_webpage round=${rounds} duration=${Date.now() - tTool}ms`);
      } else if (tc.name === "search_web" && parsedArgs.query) {
        send?.("status", { label: "Webで検索しています。" });
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
        console.log(`[search-timing] tool search_web round=${rounds} duration=${Date.now() - tTool}ms`);
      } else if (tc.name.includes("__") && mcpConnections && mcpConnections.length > 0) {
        // MCP ツール: 関数名形式 "{serverName}__{toolName}"
        const parsed = parseMcpToolFunctionName(tc.name);
        if (parsed) {
          const conn = mcpConnections.find((c) => c.serverName === parsed.serverName);
          if (conn) {
            send?.("status", { label: `MCP: ${parsed.serverName}/${parsed.toolName} を実行中` });
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
        // コネクションツール: "notion_" プレフィックスでプロバイダーを識別。
        // Notion は現状唯一のプロバイダーなので最初のマッチするコネクションを使用。
        const conn = connectionRows[0];
        send?.("status", { label: `Notion: ${tc.name} を実行中` });
        try {
          let connArgs: Record<string, unknown>;
          try {
            connArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
          } catch {
            connArgs = {};
          }
          const result = await dispatchConnectionTool(conn, tc.name, connArgs);
          toolContent = result.content;
          // リフレッシュされたトークンがあれば DB へ永続化
          if (result.newAccessToken && result.newRefreshToken) {
            try {
              await db.update(connections)
                .set({ accessToken: result.newAccessToken, refreshToken: result.newRefreshToken, updatedAt: new Date() })
                .where(eq(connections.id, conn.id));
            } catch {
              // 永続化エラーは無視 — 次回呼び出しで再度リフレッシュされる
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
      send?.("status", { label: "検索回数上限に達しました。" });
    }

    // 再ストリーミング（次のラウンド）
  }
}
