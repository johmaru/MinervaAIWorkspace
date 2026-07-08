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

// /api/folders CRUD は純粋に DB を叩く。各テストで作成したフォルダ・スレッドは afterAll で掃除。

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
  it("空でも 200 + 配列を返す", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("POST /api/folders", () => {
  it("デフォルト値で作成 (name=New folder, memoryScope=global)", async () => {
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

  it("name を指定して作成", async () => {
    const res = await POST(jsonReq("POST", { name: "仕事" }));
    expect(res.status).toBe(201);
    const folder = (await res.json()) as { id: string; name: string };
    expect(folder.name).toBe("仕事");
    createdFolderIds.push(folder.id);
  });

  it("memoryScope=folder を指定して作成", async () => {
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

  it("空白 name は 'New folder' にフォールバック", async () => {
    const res = await POST(jsonReq("POST", { name: "   " }));
    expect(res.status).toBe(201);
    const folder = (await res.json()) as { id: string; name: string };
    expect(folder.name).toBe("New folder");
    createdFolderIds.push(folder.id);
  });

  it("instruction を指定して作成", async () => {
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

  it("空白のみの instruction は null に正規化", async () => {
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

  it("instruction の前後空白をトリム", async () => {
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

  it("不正 memoryScope は 'global' にフォールバック", async () => {
    const res = await POST(
      jsonReq("POST", { name: "bad-scope", memoryScope: "banana" }),
    );
    expect(res.status).toBe(201);
    const folder = (await res.json()) as {
      id: string;
      memoryScope: string;
    };
    expect(folder.memoryScope).toBe("global");
    createdFolderIds.push(folder.id);
  });

  it("不正 JSON は 400", async () => {
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
  it("id 必須、未指定は 400", async () => {
    const res = await PATCH(jsonReq("PATCH", { name: "x" }));
    expect(res.status).toBe(400);
  });

  it("name を更新", async () => {
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

  it("instruction を更新（null クリア含む）", async () => {
    const create = await POST(
      jsonReq("POST", { name: "instr", instruction: "元の指示" }),
    );
    const created = (await create.json()) as { id: string };
    createdFolderIds.push(created.id);

    // null でクリア
    const res = await PATCH(
      jsonReq("PATCH", { instruction: null }, `id=${created.id}`),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { instruction: string | null };
    expect(updated.instruction).toBeNull();
  });

  it("memoryScope を更新", async () => {
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

  it("不正 memoryScope は 400", async () => {
    const create = await POST(jsonReq("POST", { name: "bad-patch" }));
    const created = (await create.json()) as { id: string };
    createdFolderIds.push(created.id);

    const res = await PATCH(
      jsonReq("PATCH", { memoryScope: "banana" }, `id=${created.id}`),
    );
    expect(res.status).toBe(400);
  });

  it("空白 name は 'New folder' にフォールバック", async () => {
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

  it("空白のみの instruction は null に正規化", async () => {
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

  it("instruction の前後空白をトリム", async () => {
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

  it("存在しない id は 404", async () => {
    const res = await PATCH(
      jsonReq("PATCH", { name: "x" }, "id=00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });

  it("不正 JSON は 400", async () => {
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
  it("フォルダ削除で 204", async () => {
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

  it("存在しない id は 404", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/folders/00000000-0000-0000-0000-000000000000", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
    );
    expect(res.status).toBe(404);
  });

  it("削除後 threads.folderId が null になる（ON DELETE SET NULL）", async () => {
    // フォルダ作成
    const createFolder = await POST(jsonReq("POST", { name: "親フォルダ" }));
    const folder = (await createFolder.json()) as { id: string };
    createdFolderIds.push(folder.id);

    // スレッド作成してフォルダに割当
    const [thread] = await db
      .insert(threads)
      .values({ title: "フォルダ所属スレッド", folderId: folder.id })
      .returning();
    createdThreadIds.push(thread.id);

    // フォルダ削除
    const res = await DELETE(
      new Request(`http://localhost/api/folders/${folder.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: folder.id }) },
    );
    expect(res.status).toBe(204);

    // スレッドの folderId が null になっているか確認
    const [updated] = await db
      .select({ folderId: threads.folderId })
      .from(threads)
      .where(eq(threads.id, thread.id));
    expect(updated.folderId).toBeNull();

    // afterAll で掃除されないよう createdFolderIds から除外（既に削除済み）
    const idx = createdFolderIds.indexOf(folder.id);
    if (idx >= 0) createdFolderIds.splice(idx, 1);
  });
});
