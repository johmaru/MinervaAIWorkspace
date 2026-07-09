// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
import { db } from "@/db";
import { messages, threads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { POST as createThread } from "@/app/api/threads/route";
import { DELETE, GET } from "@/app/api/threads/[id]/route";

// Verify GET/DELETE for /api/threads/[id].
// Phase 2 uses flat linear conversations (parent_id = NULL).

const createdThreadIds: string[] = [];

afterAll(async () => {
  for (const id of createdThreadIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
});

function ctx(id: string): RouteContext<"/api/threads/[id]"> {
  return { params: Promise.resolve({ id }) } as unknown as RouteContext<"/api/threads/[id]">;
}

async function createThreadWithTitle(title: string): Promise<string> {
  const res = await createThread(
    new Request("http://localhost/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
  const thread = (await res.json()) as { id: string };
  createdThreadIds.push(thread.id);
  return thread.id;
}

describe("GET /api/threads/[id]", () => {
  it("returns existing thread + message list", async () => {
    const id = await createThreadWithTitle("GET テスト");
    // Insert messages directly into DB
    await db.insert(messages).values([
      { threadId: id, role: "user", content: "こんにちは" },
      { threadId: id, role: "assistant", content: "どうも" },
    ]);

    const res = await GET(new Request(`http://localhost/api/threads/${id}`), ctx(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      thread: { id: string; title: string };
      messages: { role: string; content: string }[];
    };
    expect(data.thread.id).toBe(id);
    expect(data.thread.title).toBe("GET テスト");
    expect(data.messages).toHaveLength(2);
    const userMsg = data.messages.find((m) => m.role === "user");
    const assistantMsg = data.messages.find((m) => m.role === "assistant");
    expect(userMsg?.content).toBe("こんにちは");
    expect(assistantMsg?.content).toBe("どうも");
  });

  it("nonexistent id returns 404", async () => {
    const res = await GET(
      new Request("http://localhost/api/threads/00000000-0000-0000-0000-000000000000"),
      ctx("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/threads/[id]", () => {
  it("deletes thread and returns 204", async () => {
    const id = await createThreadWithTitle("DELETE テスト");
    const res = await DELETE(new Request(`http://localhost/api/threads/${id}`), ctx(id));
    expect(res.status).toBe(204);
    // Verify deletion
    const [row] = await db.select().from(threads).where(eq(threads.id, id));
    expect(row).toBeUndefined();
    // Remove from tracking to avoid double deletion in afterAll
    const idx = createdThreadIds.indexOf(id);
    if (idx >= 0) createdThreadIds.splice(idx, 1);
  });

  it("nonexistent id returns 404", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/threads/00000000-0000-0000-0000-000000000000"),
      ctx("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });

  it("messages are also removed via cascade", async () => {
    const id = await createThreadWithTitle("CASCADE テスト");
    await db.insert(messages).values({ threadId: id, role: "user", content: "x" });
    const res = await DELETE(new Request(`http://localhost/api/threads/${id}`), ctx(id));
    expect(res.status).toBe(204);
    const msgs = await db.select().from(messages).where(eq(messages.threadId, id));
    expect(msgs).toHaveLength(0);
    const idx = createdThreadIds.indexOf(id);
    if (idx >= 0) createdThreadIds.splice(idx, 1);
  });
});
