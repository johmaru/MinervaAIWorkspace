import { createLLM, defaultModel, type ChatMessage } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  messages: ChatMessage[];
  systemPrompt?: string;
  model?: string;
};

/**
 * SSE ストリーミングチャット。
 * クライアントは `messages` を昇順で送る（古い順）。
 * サーバは systemPrompt を先頭に付け、最新 user 発言に向けて生成。
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response("messages is required", { status: 400 });
  }

  const llm = createLLM();
  const model = body.model ?? defaultModel();

  const messages: ChatMessage[] = [
    ...(body.systemPrompt ? [{ role: "system" as const, content: body.systemPrompt }] : []),
    ...body.messages,
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      try {
        const completion = await llm.chat.completions.create({
          model,
          messages,
          stream: true,
        });

        for await (const chunk of completion) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) send("delta", { delta });
        }
        send("done", {});
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : "stream error" });
      } finally {
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
