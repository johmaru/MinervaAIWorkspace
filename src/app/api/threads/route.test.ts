// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
import { db } from "@/db";
import { folders, threads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { GET, PATCH, POST } from "@/app/api/threads/route";

// Phase 2: /api/threads CRUD directly hits the DB (no LLM).
// Threads created in each test are cleaned up in bulk in afterAll.
// IDs are tracked and deleted at the end to avoid collisions in parallel execution.

const createdIds: string[] = [];
const createdFolderIds: string[] = [];

afterAll(async () => {
  for (const id of createdIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
  for (const id of createdFolderIds) {
    await db.delete(folders).where(eq(folders.id, id));
  }
});

function jsonReq(method: string, body?: unknown, query?: string): Request {
  const url = query ? `http://localhost/api/threads?${query}` : "http://localhost/api/threads";
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/threads", () => {
  it("returns 200 + array even when empty", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("POST /api/threads", () => {
  it("creates with 'New chat' when title is omitted", async () => {
    const res = await POST(jsonReq("POST", {}));
    expect(res.status).toBe(201);
    const thread = (await res.json()) as { id: string; title: string };
    expect(thread.title).toBe("New chat");
    createdIds.push(thread.id);
  });

  it("creates with specified title", async () => {
    const res = await POST(jsonReq("POST", { title: "テスト用スレッド" }));
    expect(res.status).toBe(201);
    const thread = (await res.json()) as { id: string; title: string };
    expect(thread.title).toBe("テスト用スレッド");
    createdIds.push(thread.id);
  });

  it("blank title falls back to 'New chat'", async () => {
    const res = await POST(jsonReq("POST", { title: "   " }));
    expect(res.status).toBe(201);
    const thread = (await res.json()) as { id: string; title: string };
    expect(thread.title).toBe("New chat");
    createdIds.push(thread.id);
  });

  it("invalid JSON returns 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/threads", () => {
  it("id is required, missing returns 400", async () => {
    const res = await PATCH(jsonReq("PATCH", { title: "x" }));
    expect(res.status).toBe(400);
  });

  it("updates title", async () => {
    const create = await POST(jsonReq("POST", {}));
    const created = (await create.json()) as { id: string };
    createdIds.push(created.id);

    const res = await PATCH(jsonReq("PATCH", { title: "リネーム後" }, `id=${created.id}`));
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { id: string; title: string };
    expect(updated.title).toBe("リネーム後");
  });

  it("nonexistent id returns 404", async () => {
    const res = await PATCH(
      jsonReq("PATCH", { title: "x" }, "id=00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });

  it("can also update model", async () => {
    const create = await POST(jsonReq("POST", {}));
    const created = (await create.json()) as { id: string };
    createdIds.push(created.id);

    const res = await PATCH(jsonReq("PATCH", { model: "umans-glm-5.2" }, `id=${created.id}`));
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { model: string };
    expect(updated.model).toBe("umans-glm-5.2");
  });
});

describe("PATCH /api/threads — folderId", () => {
  it("updates folderId to assign to a folder", async () => {
    // Create folder
    const [folder] = await db
      .insert(folders)
      .values({ name: "割当先フォルダ" })
      .returning();
    createdFolderIds.push(folder.id);

    // Create thread
    const create = await POST(jsonReq("POST", {}));
    const created = (await create.json()) as { id: string };
    createdIds.push(created.id);

    const res = await PATCH(
      jsonReq("PATCH", { folderId: folder.id }, `id=${created.id}`),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { folderId: string | null };
    expect(updated.folderId).toBe(folder.id);
  });

  it("clears folderId with null (removes from folder)", async () => {
    // Create folder + create thread with folder
    const [folder] = await db
      .insert(folders)
      .values({ name: "クリア元フォルダ" })
      .returning();
    createdFolderIds.push(folder.id);

    const create = await POST(jsonReq("POST", { folderId: folder.id }));
    const created = (await create.json()) as { id: string; folderId: string | null };
    createdIds.push(created.id);
    expect(created.folderId).toBe(folder.id);

    // Clear with null
    const res = await PATCH(
      jsonReq("PATCH", { folderId: null }, `id=${created.id}`),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { folderId: string | null };
    expect(updated.folderId).toBeNull();
  });
});

describe("GET /api/threads — includes folderId", () => {
  it("GET response includes folderId", async () => {
    const [folder] = await db
      .insert(folders)
      .values({ name: "GET 検証フォルダ" })
      .returning();
    createdFolderIds.push(folder.id);

    const create = await POST(jsonReq("POST", { folderId: folder.id }));
    const created = (await create.json()) as { id: string };
    createdIds.push(created.id);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ id: string; folderId: string | null }>;
    const found = data.find((t) => t.id === created.id);
    expect(found).toBeDefined();
    expect(found!.folderId).toBe(folder.id);
  });
});
