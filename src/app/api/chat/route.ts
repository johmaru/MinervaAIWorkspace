import { and, asc, eq } from "drizzle-orm";
import { createLLM, defaultModel, getReasoningLevels, getDefaultReasoningEffort } from "@/lib/llm";
import { db } from "@/db";
import { messages, threads } from "@/db/schema";
import { getRequestLocale, t } from "@/lib/i18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  threadId: string;
  content: string; // 最新 user 発言の本文
  systemPrompt?: string;
  model?: string;
};

/**
 * SSE ストリーミングチャット + DB 永続化（Phase 2）。
 *
 * - DB から当該スレッドの過去メッセージを昇順で読み出し LLM context に構成。
 * - 受け取った user 発言を DB に保存。
 * - LLM 生成を SSE でストリーミングしつつ全文を蓄積し、完了時に assistant を DB に保存。
 * - スレッドの title が "New chat" のままなら、最初の user 発言から自動生成。
 *
 * Phase 2 は flat 線形会話（parent_id = NULL）。Phase 5 でツリー化する。
 */
export async function POST(req: Request) {
  const locale = getRequestLocale(req);
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.threadId) return new Response("threadId is required", { status: 400 });
  const content = body.content?.trim();
  if (!content) return new Response("content is required", { status: 400 });

  // スレッド存在確認
  const [thread] = await db.select().from(threads).where(eq(threads.id, body.threadId));
  if (!thread) return new Response("thread not found", { status: 404 });

  // 過去メッセージ（昇順）を DB から読み出し
  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, body.threadId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  // user 発言を保存
  const [userMsg] = await db
    .insert(messages)
    .values({ threadId: body.threadId, role: "user", content })
    .returning();

  // title 自動生成: 初回（メッセージ0件だった）なら user 発言から
  if (thread.title === "New chat" && history.length === 0) {
    const title = content.slice(0, 40) + (content.length > 40 ? "…" : "");
    await db
      .update(threads)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(threads.id, body.threadId)));
  }

  const llm = createLLM();
  const model = body.model ?? thread.model ?? defaultModel();

  const systemContent = thread.systemPrompt ?? body.systemPrompt;
    const llmMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
      ...(systemContent ? [{ role: "system" as const, content: systemContent }] : []),
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content },
    ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      let assistantContent = "";
      try {
        // 生成開始をクライアントに通知（user メッセージの DB id を返す）
        send("start", { userMessageId: userMsg.id });

        const thinkingEffort = process.env.THINKING_EFFORT;
        const validLevels = getReasoningLevels(model);
        const reasoningEffort =
          thinkingEffort && validLevels.includes(thinkingEffort)
            ? thinkingEffort
            : getDefaultReasoningEffort(model);

        const completion = await llm.chat.completions.create({
          model,
          messages: llmMessages,
          stream: true,
          ...(reasoningEffort
            ? { reasoning_effort: reasoningEffort as "none" | "low" | "medium" | "high" }
            : {}),
        });

        for await (const chunk of completion) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            assistantContent += delta;
            send("delta", { delta });
          }
        }

        // assistant 全文を DB に保存
        const [assistantMsg] = await db
          .insert(messages)
          .values({ threadId: body.threadId, role: "assistant", content: assistantContent })
          .returning();
        send("done", { assistantMessageId: assistantMsg.id });
      } catch (err) {
        // 部分回答でも保存しておく（Phase 5 の再生成で枝を切り替えられるよう）
        if (assistantContent) {
          await db
            .insert(messages)
            .values({ threadId: body.threadId, role: "assistant", content: assistantContent })
            .returning();
        }
        send("error", { message: err instanceof Error ? err.message : t(locale, "chat.streamError") });
      } finally {
        // スレッドの更新日時を更新
        await db
          .update(threads)
          .set({ updatedAt: new Date() })
          .where(eq(threads.id, body.threadId));
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
