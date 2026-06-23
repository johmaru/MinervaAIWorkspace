import { and, asc, eq } from "drizzle-orm";
import type OpenAI from "openai";
import { createLLM, defaultModel, getReasoningLevels, getDefaultReasoningEffort, availableModels, isUmansProvider } from "@/lib/llm";
import { db } from "@/db";
import { messages, threads } from "@/db/schema";
import { getRequestLocale, t } from "@/lib/i18n";
import { searchWeb } from "@/lib/scraper";
import type { SourceInfo } from "@/lib/scraper";
import { decideSearch } from "@/lib/searchDecision";
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
  const webSearchProvider = process.env.WEB_SEARCH_PROVIDER || "searxng";
  const umansSearchProvider =
    (webSearchProvider === "native" || webSearchProvider === "exa") && isUmansProvider()
      ? webSearchProvider
      : null;
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

        const searchContextMessage = umansSearchProvider
          ? null
          : await buildSearchContext({
              content: prepared.content,
              model: finalModel,
              history: prepared.history,
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
            webSearchProvider: umansSearchProvider,
            send,
          });
        } else {
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
            webSearchProvider: umansSearchProvider,
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

async function buildSearchContext({
  content,
  model,
  history,
  send,
}: {
  content: string;
  model: string;
  history: DbMessage[];
  send: StreamSend;
}): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam | null> {
  const decision = await decideSearch(
    content,
    model,
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

  return {
    role: "system",
    content: `Web search results (use these to answer):\n${JSON.stringify(allResults, null, 2)}`,
  };
}

function buildFinalMessages({
  systemContent,
  history,
  content,
  searchContextMessage,
  memoryMessage,
}: {
  systemContent?: string | null;
  history: DbMessage[];
  content: string;
  searchContextMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam | null;
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

async function streamCompletion({
  llm,
  model,
  messages: messagesForModel,
  onDelta,
  onReasoning,
  webSearchProvider,
  send,
}: {
  llm: OpenAI;
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  onDelta: (delta: string) => void;
  onReasoning: (delta: string) => void;
  webSearchProvider?: string | null;
  send?: StreamSend;
}) {
  const thinkingEffort = process.env.THINKING_EFFORT;
  const validLevels = await getReasoningLevels(model);
  const reasoningEffort =
    thinkingEffort && validLevels.includes(thinkingEffort)
      ? thinkingEffort
      : await getDefaultReasoningEffort(model);

  const tools = webSearchProvider
    ? [
        {
          type: "function" as const,
          function: {
            name: "web_search",
            description: "Search the web for current information.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "The search query" },
              },
              required: ["query"],
            },
          },
        },
      ]
    : undefined;

  const requestOptions = webSearchProvider
    ? { headers: { "X-Umans-Websearch-Provider": webSearchProvider } }
    : undefined;

  const maxRounds = Math.min(5, Math.max(1, Number(process.env.WEB_SEARCH_MAX_ROUNDS) || 2));
  const maxResults = Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3;

  // Tool-call ループ: LLM が web_search ツールを呼んだら検索を実行し、
  // 結果を role:"tool" で返して回答を再生成させる。
  // native/exa どちらも Umans エンドポイントは tool_calls を返すだけで
  // 自動実行しないため、アプリ側でこのループが必要。
  for (let round = 0; round < maxRounds; round++) {
    const completion = await llm.chat.completions.create(
      {
        model,
        messages: messagesForModel,
        stream: true,
        ...(tools ? { tools } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      requestOptions,
    );

    // ストリーミングチャンクを蓄積しつつクライアントへ転送
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] = [];
    let finishReason: string | null = null;

    for await (const chunk of completion) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const reasoningDelta = (
        choice.delta as Record<string, unknown> as { reasoning_content?: string }
      ).reasoning_content;
      if (reasoningDelta) onReasoning(reasoningDelta);
      const contentDelta = choice.delta?.content;
      if (contentDelta) onDelta(contentDelta);

      // tool_calls デルタを蓄積（ストリーミング分割対応）
      const deltaToolCalls = choice.delta?.tool_calls;
      if (deltaToolCalls) {
        for (const dtc of deltaToolCalls) {
          const idx = dtc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = {
              id: dtc.id ?? "",
              type: "function",
              function: { name: "", arguments: "" },
            };
          }
          if (dtc.id) toolCalls[idx].id = dtc.id;
          if (dtc.function?.name) toolCalls[idx].function.name += dtc.function.name;
          if (dtc.function?.arguments) toolCalls[idx].function.arguments += dtc.function.arguments;
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    // tool_calls で終了しなければ完了（stop / length 等）
    if (finishReason !== "tool_calls") break;

    // 有効な tool_call がなければ終了（無限ループ防止）
    const validToolCalls = toolCalls.filter((tc) => tc && tc.function.name === "web_search");
    if (validToolCalls.length === 0) break;

    // assistant メッセージ（tool_calls 含む）を会話に追加
    messagesForModel.push({
      role: "assistant",
      content: null,
      tool_calls: validToolCalls,
    } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);

    // 各 tool_call に対して検索を実行し、結果を role:"tool" で返す
    for (const tc of validToolCalls) {
      let query = "";
      try {
        query = (JSON.parse(tc.function.arguments) as { query?: string }).query ?? "";
      } catch {
        // 引数パース失敗は空クエリとして扱う
      }

      if (send) send("status", { label: `「${query}」を検索中…` });

      let toolContent: string;
      try {
        const response = await searchWeb(query, maxResults);
        const sources: SourceInfo[] = response.results.map((r) => ({
          url: r.url,
          title: r.scrapeTitle || r.title,
          snippet: r.snippet,
        }));
        if (send && sources.length > 0) send("sources", { sources });

        const results = response.results.map((r) => ({
          url: r.url,
          title: r.scrapeTitle || r.title,
          snippet: r.snippet,
          content: r.scraped ? r.content.slice(0, SEARCH_RESULT_CONTENT_SLICE) : "",
        }));
        toolContent = JSON.stringify(results);
      } catch {
        // 検索失敗は空結果として LLM に返す
        toolContent = "[]";
      }

      messagesForModel.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolContent,
      } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam);
    }

    // 次ラウンドで LLM が検索結果を受け取り回答を生成する
  }
}
