import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { memories, threads } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/memories — ログインユーザーの全メモリ（更新順）。
 * suppressedAt IS NULL（論理削除されていない）もののみ返す。
 * embedding は含まず、メタ + threadTitle のみ。
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const rows = await db
    .select({
      id: memories.id,
      threadId: memories.threadId,
      threadTitle: threads.title,
      folderId: memories.folderId,
      kind: memories.kind,
      content: memories.content,
      importance: memories.importance,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .innerJoin(threads, eq(memories.threadId, threads.id))
    .where(and(eq(threads.userId, user.id), isNull(memories.suppressedAt)))
    .orderBy(desc(memories.updatedAt));
  return Response.json(rows);
}

type CreateBody = {
  content?: string;
  kind?: "fact" | "working";
  importance?: number;
  threadId?: string;
};

/**
 * POST /api/memories — メモリ手動作成。
 * content + threadId を受け取り、embedding + contentHash を生成して保存。
 * スレッド所有権を確認し、他ユーザーのスレッドには追加できない。
 * 重複チェックはしない（手動追加は同一内容でも異なる文脈を許容）。
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  let body: CreateBody = {};
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const content = body.content?.trim();
  if (!content) return new Response("content is required", { status: 400 });
  if (!body.threadId) return new Response("threadId is required", { status: 400 });
  const kind = body.kind === "working" ? "working" : "fact";
  const importance =
    typeof body.importance === "number" ? Math.max(0, Math.min(1, body.importance)) : 0.5;

  // スレッド所有権確認
  const [thread] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, body.threadId), eq(threads.userId, user.id)))
    .limit(1);
  if (!thread) return new Response("thread not found", { status: 400 });

  const vector = await embedText(content, "document");
  if (vector.length === 0) return new Response("Embedding failed", { status: 503 });
  const contentHash = hashContent(content);

  const [row] = await db
    .insert(memories)
    .values({
      threadId: body.threadId,
      folderId: null,
      kind,
      content,
      embedding: vector,
      contentHash,
      model: "manual",
      importance,
    })
    .returning({
      id: memories.id,
      threadId: memories.threadId,
      kind: memories.kind,
      content: memories.content,
      importance: memories.importance,
    });
  return Response.json(row, { status: 201 });
}
