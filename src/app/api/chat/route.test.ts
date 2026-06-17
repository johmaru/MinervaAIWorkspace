// @vitest-environment node
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/chat/route";

// Phase 1 受け入れ: /api/chat は OpenAI 互換 LLM (実 API) に接続し、
// SSE で delta → done をストリーミングする。
// .env の LLM_BASE_URL / LLM_API_KEY / LLM_MODEL を使用（vitest.setup.ts で読み込み済み）。

const hasCreds = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
const itReal = hasCreds ? it : it.skip;

function sseChunks(res: Response): Promise<string> {
  return res.text();
}

function parseEvents(raw: string): { event: string; data: Record<string, unknown> }[] {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    let dataLine = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
    }
    if (!dataLine) continue;
    try {
      out.push({ event, data: JSON.parse(dataLine) });
    } catch {
      // 無視
    }
  }
  return out;
}

describe("POST /api/chat — バリデーション", () => {
  it("空ボディは 400", async () => {
    const res = await POST(new Request("http://localhost/api/chat", { method: "POST" }));
    expect(res.status).toBe(400);
  });

  it("不正 JSON は 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("messages が空配列は 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/chat — 実 API ストリーミング", () => {
  itReal("SSE で delta を受信し done で終わる", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "「OK」とだけ2文字で返して。" }],
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.body).toBeInstanceOf(ReadableStream);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    // 少なくとも1つの delta と、最後の done が必須
    const deltas = events.filter((e) => e.event === "delta" && typeof e.data.delta === "string");
    const done = events.filter((e) => e.event === "done");
    expect(deltas.length).toBeGreaterThan(0);
    expect(done.length).toBe(1);

    // 連結して空でない本文
    const text = deltas.map((e) => e.data.delta as string).join("");
    expect(text.length).toBeGreaterThan(0);

    // error イベントは来てはならない
    expect(events.some((e) => e.event === "error")).toBe(false);
  }, 60_000);

  itReal("systemPrompt を先頭に付与しても 200 で応答", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "日本の首都は？" }],
          systemPrompt: "一言で答えて。",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await sseChunks(res));
    expect(events.filter((e) => e.event === "done").length).toBe(1);
    expect(events.some((e) => e.event === "error")).toBe(false);
  }, 60_000);
});
