import { and, asc, eq } from "drizzle-orm";
import type OpenAI from "openai";
import { createLLM, defaultModel, defaultSearchModel, getReasoningLevels, getDefaultReasoningEffort, availableModels } from "@/lib/llm";
import { db } from "@/db";
import { messages, threads } from "@/db/schema";
import { getRequestLocale, t } from "@/lib/i18n";
import { scrapeUrl, searchWeb } from "@/lib/scraper";
import type { SourceInfo } from "@/lib/scraper";
import { extractUrls } from "@/lib/urlExtract";
import { decideSearch } from "@/lib/searchDecision";
import { probeToolSupport } from "@/lib/toolProbe";
import type { ToolSupport } from "@/lib/toolProbe";
import { buildMemoryContext } from "@/lib/memoryStore";
import { generateMemories } from "@/lib/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEARCH_RESULT_CONTENT_SLICE = 2000;

type Body = {
  threadId: string;
  content?: string;
  systemPrompt?: string;
  model?: string;
  mode?: "send" | "regenerate" | "edit";
  parentMessageId?: string;
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
  const systemContent = thread.systemPrompt ?? body.systemPrompt;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send: StreamSend = (event, data) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      let assistantContent = "";
      let assistantReasoning = "";
      let dualTrace: DualTrace | undefined;

      try {
        send("start", { userMessageId: prepared.userMessage.id });
        const searchContextMessage = await buildSearchContext({
          content: prepared.content,
          llm,
          history: prepared.history,
          send,
        });

        const urlContextMessage = await buildUrlContext({
          content: prepared.content,
          send,
        });

        const memoryMessage = await buildMemoryContext({
          content: prepared.content,
          thread,
        });

        const finalMessages = buildFinalMessages({
          systemContent,
          history: prepared.history,
          content: prepared.content,
          searchContextMessage,
          urlContextMessage,
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
          });
        } else {
          // 関数呼び出し（ツール使用）プローブ: モデルがツール使用をサポートするか判定。
          // サポート時はストリーミング中に自律的に検索/スクレイプを実行。
          // 非サポート時は decideSearch ルーター方式（buildSearchContext）にフォールバック。
          let toolSupport: ToolSupport | null = null;
          try {
            toolSupport = await probeToolSupport(llm, finalModel);
          } catch {
            toolSupport = null;
          }
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
            toolSupport,
            send,
          });
        }
        const [assistantMsg] = await db
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
          .set({ currentLeafId: assistantMsg.id, updatedAt: new Date() })
          .where(eq(threads.id, body.threadId));

        send("done", { assistantMessageId: assistantMsg.id });
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

        // 記憶生成: ストリーム完了後に同期的に保存する。
        // done イベントは既に送信済み（クライアント受信済み）なので、
        // ここで await してもクライアント UX に影響しない。
        // エラーは握りつぶす（ストリーム既に完了済み、ログのみ）。
        if (assistantContent) {
          try {
            await generateMemories(
              body.threadId,
              [
                { role: "user", content: prepared.content },
                { role: "assistant", content: assistantContent },
              ],
              llm,
              finalModel,
            );
          } catch (err) {
            console.error("[memory] generation failed:", err);
          }
        }

        controller.close();
      }
    },
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
}: {
  content: string;
  llm: OpenAI;
  history: DbMessage[];
  send: StreamSend;
}): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam | null> {
  const searchModel = defaultSearchModel();
  const decision = await decideSearch(
    content,
    searchModel,
    history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content })),
  );

  if (!decision.needsSearch || decision.queries.length === 0) return null;

  send("status", { label: decision.userNotice ?? "最新情報を確認するね。" });

  const maxResults = Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3;
  const maxRounds = Math.min(5, Math.max(1, Number(process.env.WEB_SEARCH_MAX_ROUNDS) || 2));
  const allSources: SourceInfo[] = [];
  const allResults: { url: string; title: string; snippet: string; content: string }[] = [];

  for (const query of decision.queries.slice(0, maxRounds)) {
    try {
      const response = await searchWeb(query, maxResults);
      for (const r of response.results) {
        allSources.push({ url: r.url, title: r.scrapeTitle || r.title, snippet: r.snippet });
        allResults.push({
          url: r.url,
          title: r.scrapeTitle || r.title,
          snippet: r.snippet,
          content: r.scraped ? r.content.slice(0, SEARCH_RESULT_CONTENT_SLICE) : "",
        });
      }
    } catch {
      // 個別クエリ失敗は無視して次へ
    }
  }

  if (allSources.length > 0) send("sources", { sources: allSources });
  if (allResults.length === 0) return null;

  // 検索結果を検索専用モデルで要約してから system メッセージにする。
  // 要約失敗時は生 JSON にフォールバック。
  const summarizeMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "Summarize the following web search results into a concise, factual briefing. Preserve key facts, numbers, dates, and source URLs. Do not add speculation. Answer in the user's language.",
    },
    {
      role: "user",
      content: `User question: ${content}\n\nSearch results:\n${JSON.stringify(allResults, null, 2)}`,
    },
  ];

  let summary = "";
  try {
    summary = await completeText(llm, searchModel, summarizeMessages);
  } catch {
    // 要約失敗時は生 JSON を使う
  }
  const contextContent = summary || JSON.stringify(allResults, null, 2);

  return {
    role: "system",
    content: `Web search results (use these to answer):\n${contextContent}`,
  };
}

function buildFinalMessages({
  systemContent,
  history,
  content,
  searchContextMessage,
  urlContextMessage,
  memoryMessage,
}: {
  systemContent?: string | null;
  history: DbMessage[];
  content: string;
  searchContextMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam | null;
  urlContextMessage?: OpenAI.Chat.Completions.ChatCompletionMessageParam | null;
  memoryMessage?: { role: "system"; content: string } | null;
}): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    ...(systemContent ? [{ role: "system" as const, content: systemContent }] : []),
    ...(memoryMessage ? [memoryMessage] : []),
    ...history.map(
      (m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam,
    ),
    { role: "user" as const, content },
    ...(searchContextMessage ? [searchContextMessage] : []),
    ...(urlContextMessage ? [urlContextMessage] : []),
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
): Promise<string> {
  const completion = await llm.chat.completions.create({
    model,
    messages: messagesForModel,
    stream: false,
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
}: {
  llm: OpenAI;
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  onDelta: (delta: string) => void;
  onReasoning: (delta: string) => void;
  toolSupport?: ToolSupport | null;
  send?: StreamSend;
}) {
  const thinkingEffort = process.env.THINKING_EFFORT;
  const validLevels = await getReasoningLevels(model);
  const reasoningEffort =
    thinkingEffort && validLevels.includes(thinkingEffort)
      ? thinkingEffort
      : await getDefaultReasoningEffort(model);

  const useTools = toolSupport?.supported === true && send !== undefined;

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
        ? { tools: STREAM_TOOLS, tool_choice: "auto" }
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
      } else if (tc.name === "search_web" && parsedArgs.query) {
        send?.("status", { label: "Webで検索しています。" });
        try {
          const response = await searchWeb(parsedArgs.query, 3);
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
