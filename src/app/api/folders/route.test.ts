// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
import { db } from "@/db";
import { folders, threads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { GET, PATCH, POST } from "@/app/api/folders/route";
import { DELETE } from "@/app/api/folders/[id]/route";

// /api/folders CRUD directly hits the DB. Folders and threads created in each test are cleaned up in afterAll.

const createdFolderIds: string[] = [];
const createdThreadIds: string[] = [];

afterAll(async () => {
  for (const id of createdThreadIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
  for (const id of createdFolderIds) {
    await db.delete(folders).where(eq(folders.id, id));
  }
});

function jsonReq(method: string, body?: unknown, query?: string): Request {
  const url = query
    ? `http://localhost/api/folders?${query}`
    : "http://localhost/api/folders";
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/folders", () => {
  it("returns 200 + array even when empty", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("POST /api/folders", () => {
  it("creates with defaults (name=New folder, memoryScope=global)", async () => {
    const res = await POST(jsonReq("POST", {}));
    expect(res.status).toBe(201);
    const folder = (await res.json()) as {
      id: string;
      name: string;
      instruction: string | null;
      memoryScope: string;
    };
    expect(folder.name).toBe("New folder");
    expect(folder.instruction).toBeNull();
    expect(folder.memoryScope).toBe("global");
    createdFolderIds.push(folder.id);
  });

  it("creates with a specified name", async () => {
    const res = await POST(jsonReq("POST", { name: "仕事" }));
    expect(res.status).toBe(201);
    const folder = (await res.json()) as { id: string; name: string };
    expect(folder.name).toBe("仕事");
    createdFolderIds.push(folder.id);
  });

  it("creates with memoryScope=folder", async () => {
    const res = await POST(
      jsonReq("POST", { name: "秘密", memoryScope: "folder" }),
    );
    expect(res.status).toBe(201);
    const folder = (await res.json()) as {
      id: string;
      memoryScope: string;
    };
    expect(folder.memoryScope).toBe("folder");
    createdFolderIds.push(folder.id);
  });

  it("blank name falls back to 'New folder'", async () => {
    const res = await POST(jsonReq("POST", { name: "   " }));
    expect(res.status).toBe(201);
    const folder = (await res.json()) as { id: string; name: string };
    expect(folder.name).toBe("New folder");
    createdFolderIds.push(folder.id);
  });

  it("creates with an instruction", async () => {
    const res = await POST(
      jsonReq("POST", { name: "敬語", instruction: "丁寧な敬語で" }),
    );
    expect(res.status).toBe(201);
    const folder = (await res.json()) as {
      id: string;
      instruction: string | null;
    };
    expect(folder.instruction).toBe("丁寧な敬語で");
    createdFolderIds.push(folder.id);
  });

  it("whitespace-only instruction is normalized to null", async () => {
    const res = await POST(
      jsonReq("POST", { name: "instr-trim", instruction: "   " }),
    );
    expect(res.status).toBe(201);
    const folder = (await res.json()) as {
      id: string;
      instruction: string | null;
    };
    expect(folder.instruction).toBeNull();
    createdFolderIds.push(folder.id);
  });

  it("trims leading/trailing whitespace from instruction", async () => {
    const res = await POST(
      jsonReq("POST", { name: "instr-trim2", instruction: "  敬語  " }),
    );
    expect(res.status).toBe(201);
    const folder = (await res.json()) as {
      id: string;
      instruction: string | null;
    };
    expect(folder.instruction).toBe("敬語");
    createdFolderIds.push(folder.id);
  });

  it("invalid memoryScope returns 400", async () => {
    const res = await POST(
      jsonReq("POST", { name: "bad-scope", memoryScope: "banana" }),
    );
    expect(res.status).toBe(400);
  });

  it("invalid JSON returns 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/folders", () => {
  it("id is required; missing id returns 400", async () => {
    const res = await PATCH(jsonReq("PATCH", { name: "x" }));
    expect(res.status).toBe(400);
  });

  it("updates name", async () => {
    const create = await POST(jsonReq("POST", { name: "元の名前" }));
    const created = (await create.json()) as { id: string };
    createdFolderIds.push(created.id);

    const res = await PATCH(
      jsonReq("PATCH", { name: "新しい名前" }, `id=${created.id}`),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { id: string; name: string };
    expect(updated.name).toBe("新しい名前");
  });

  it("updates instruction (including clearing with null)", async () => {
    const create = await POST(
      jsonReq("POST", { name: "instr", instruction: "元の指示" }),
    );
    const created = (await create.json()) as { id: string };
    createdFolderIds.push(created.id);

    // Clear with null
    const res = await PATCH(
      jsonReq("PATCH", { instruction: null }, `id=${created.id}`),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { instruction: string | null };
    expect(updated.instruction).toBeNull();
  });

  it("updates memoryScope", async () => {
    const create = await POST(jsonReq("POST", { name: "scope" }));
    const created = (await create.json()) as { id: string };
    createdFolderIds.push(created.id);

    const res = await PATCH(
      jsonReq("PATCH", { memoryScope: "folder" }, `id=${created.id}`),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { memoryScope: string };
    expect(updated.memoryScope).toBe("folder");
  });

  it("invalid memoryScope returns 400", async () => {
    const create = await POST(jsonReq("POST", { name: "bad-patch" }));
    const created = (await create.json()) as { id: string };
    createdFolderIds.push(created.id);

    const res = await PATCH(
      jsonReq("PATCH", { memoryScope: "banana" }, `id=${created.id}`),
    );
    expect(res.status).toBe(400);
  });

  it("blank name falls back to 'New folder'", async () => {
    const create = await POST(jsonReq("POST", { name: "元の名前" }));
    const created = (await create.json()) as { id: string };
    createdFolderIds.push(created.id);

    const res = await PATCH(
      jsonReq("PATCH", { name: "   " }, `id=${created.id}`),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { name: string };
    expect(updated.name).toBe("New folder");
  });

  it("whitespace-only instruction is normalized to null", async () => {
    const create = await POST(
      jsonReq("POST", { name: "instr-patch", instruction: "元の指示" }),
    );
    const created = (await create.json()) as { id: string };
    createdFolderIds.push(created.id);

    const res = await PATCH(
      jsonReq("PATCH", { instruction: "   " }, `id=${created.id}`),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { instruction: string | null };
    expect(updated.instruction).toBeNull();
  });

  it("trims leading/trailing whitespace from instruction", async () => {
    const create = await POST(
      jsonReq("POST", { name: "instr-trim-patch", instruction: "元の指示" }),
    );
    const created = (await create.json()) as { id: string };
    createdFolderIds.push(created.id);

    const res = await PATCH(
      jsonReq("PATCH", { instruction: "  新指示  " }, `id=${created.id}`),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { instruction: string | null };
    expect(updated.instruction).toBe("新指示");
  });

  it("non-existent id returns 404", async () => {
    const res = await PATCH(
      jsonReq("PATCH", { name: "x" }, "id=00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });

  it("invalid JSON returns 400", async () => {
    const create = await POST(jsonReq("POST", {}));
    const created = (await create.json()) as { id: string };
    createdFolderIds.push(created.id);

    const res = await PATCH(
      new Request(`http://localhost/api/folders?id=${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/folders/[id]", () => {
  it("returns 204 on folder deletion", async () => {
    const create = await POST(jsonReq("POST", { name: "削除対象" }));
    const created = (await create.json()) as { id: string };

    const res = await DELETE(
      new Request(`http://localhost/api/folders/${created.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res.status).toBe(204);
  });

  it("non-existent id returns 404", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/folders/00000000-0000-0000-0000-000000000000", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(404);
  });

  it("threads.folderId becomes null after deletion (ON DELETE SET NULL)", async () => {
    // Create folder
    const createFolder = await POST(jsonReq("POST", { name: "親フォルダ" }));
    const folder = (await createFolder.json()) as { id: string };
    createdFolderIds.push(folder.id);

    // Create a thread and assign it to the folder
    const [thread] = await db
      .insert(threads)
      .values({ title: "フォルダ所属スレッド", folderId: folder.id })
      .returning();
    createdThreadIds.push(thread.id);

    // Delete folder
    const res = await DELETE(
      new Request(`http://localhost/api/folders/${folder.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: folder.id }) },
    );
    expect(res.status).toBe(204);

    // Verify the thread's folderId is now null
    const [updated] = await db
      .select({ folderId: threads.folderId })
      .from(threads)
      .where(eq(threads.id, thread.id));
    expect(updated.folderId).toBeNull();

    // Exclude from createdFolderIds so afterAll doesn't try to clean up (already deleted)
    const idx = createdFolderIds.indexOf(folder.id);
    if (idx >= 0) createdFolderIds.splice(idx, 1);
  });
});
