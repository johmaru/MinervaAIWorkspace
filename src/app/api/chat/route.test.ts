// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { threads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { POST } from "@/app/api/chat/route";

// Phase 2: /api/chat は DB 永続化 + 実 API ストリーミング。
// .env の LLM_BASE_URL / LLM_API_KEY / LLM_MODEL を使用（vitest.setup.ts で読み込み済み）。
// テストごとにスレッドを作成し、afterAll で掃除。

const hasCreds = Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);
const itReal = hasCreds ? it : it.skip;

const createdIds: string[] = [];

afterAll(async () => {
  for (const id of createdIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
});

async function createThread(): Promise<string> {
  const [row] = await db.insert(threads).values({ title: "chat route test" }).returning();
  createdIds.push(row.id);
  return row.id;
}

function chatReq(threadId: string, content: string, opts?: { systemPrompt?: string }): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify({ threadId, content, systemPrompt: opts?.systemPrompt }),
    headers: { "Content-Type": "application/json" },
  });
}

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

  it("threadId 未指定は 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({ content: "hi" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("content 未指定は 400", async () => {
    const id = await createThread();
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({ threadId: id }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("存在しない threadId は 404", async () => {
    const res = await POST(chatReq("00000000-0000-0000-0000-000000000000", "hi"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chat — 実 API ストリーミング + DB 永続化", () => {
  itReal("SSE で start/delta/done を返し user/assistant を DB に保存", async () => {
    const id = await createThread();
    const res = await POST(chatReq(id, "「OK」とだけ2文字で返して。"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.body).toBeInstanceOf(ReadableStream);

    const raw = await sseChunks(res);
    const events = parseEvents(raw);

    const start = events.filter((e) => e.event === "start");
    const deltas = events.filter((e) => e.event === "delta" && typeof e.data.delta === "string");
    const done = events.filter((e) => e.event === "done");

    expect(start).toHaveLength(1);
    expect(typeof start[0].data.userMessageId).toBe("string");
    expect(deltas.length).toBeGreaterThan(0);
    expect(done).toHaveLength(1);
    expect(typeof done[0].data.assistantMessageId).toBe("string");
    expect(events.some((e) => e.event === "error")).toBe(false);

    const text = deltas.map((e) => e.data.delta as string).join("");
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  itReal("title が New chat のとき初回送信で自動生成される", async () => {
    const [row0] = await db.insert(threads).values({ title: "New chat" }).returning();
    createdIds.push(row0.id);
    const id = row0.id;
    await POST(chatReq(id, "日本の首都は？")).then((r) => r.text());

    const [row] = await db.select().from(threads).where(eq(threads.id, id));
    expect(row).toBeDefined();
    expect(row!.title).toContain("日本の首都");
  }, 60_000);
});
