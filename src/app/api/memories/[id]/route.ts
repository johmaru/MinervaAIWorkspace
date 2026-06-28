import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { memories, threads } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * メモリ所有権確認: innerJoin(threads) でユーザースコープを担保。
 * memories は userId 列を持たないため、threadId → threads.userId でスコープ。
 */
async function assertOwned(id: string, userId: string) {
  const [row] = await db
    .select({ threadId: memories.threadId })
    .from(memories)
    .innerJoin(threads, eq(memories.threadId, threads.id))
    .where(and(eq(memories.id, id), eq(threads.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * DELETE /api/memories/[id] — メモリ論理削除。
 * suppressedAt を set する（物理削除ではない）。generateMemories の replace action と同じ扱い。
 * 論理削除で過去の会話履歴との整合性を保つ。RAG 検索は suppressedAt IS NULL で既にフィルタ。
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const row = await assertOwned(id, user.id);
  if (!row) return new Response("Not found", { status: 404 });
  await db
    .update(memories)
    .set({ suppressedAt: new Date(), updatedAt: new Date() })
    .where(eq(memories.id, id));
  return new Response(null, { status: 204 });
}

type PatchBody = {
  content?: string;
  kind?: "fact" | "working";
  importance?: number;
};

/**
 * PATCH /api/memories/[id] — メモリ部分更新。
 * content 変更時は embedding + contentHash を再生成。
 * kind/importance のみの変更では再 embed しない。
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const owned = await assertOwned(id, user.id);
  if (!owned) return new Response("Not found", { status: 404 });

  const values: Partial<typeof memories.$inferInsert> = { updatedAt: new Date() };

  if (typeof body.content === "string") {
    const c = body.content.trim();
    if (!c) return new Response("content must not be empty", { status: 400 });
    values.content = c;
    const vector = await embedText(c, "document");
    if (vector.length === 0) return new Response("Embedding failed", { status: 503 });
    values.embedding = vector;
    values.contentHash = hashContent(c);
  }
  if (body.kind === "fact" || body.kind === "working") values.kind = body.kind;
  if (typeof body.importance === "number") {
    values.importance = Math.max(0, Math.min(1, body.importance));
  }

  const [row] = await db
    .update(memories)
    .set(values)
    .where(eq(memories.id, id))
    .returning({
      id: memories.id,
      threadId: memories.threadId,
      kind: memories.kind,
      content: memories.content,
      importance: memories.importance,
    });
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}
