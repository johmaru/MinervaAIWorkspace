import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, messages, threads } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/threads/[id] — スレッド本体 + メッセージ一覧（枝分かれ情報付き）。
 *
 * Phase 5: 全メッセージを返し、各メッセージに parentId を含める。
 * クライアント側で parent chain を辿り currentLeafId の枝を表示する。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const [thread] = await db.select().from(threads).where(eq(threads.id, id));
  if (!thread) return new Response("Not found", { status: 404 });

  const msgs = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      parentId: messages.parentId,
      role: messages.role,
      content: messages.content,
      reasoning: messages.reasoning,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.threadId, id))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  // 添付ファイルを取得（messageId に紐づくもののみ）
  const atts = await db
    .select({
      id: attachments.id,
      messageId: attachments.messageId,
      filename: attachments.filename,
      mimeType: attachments.mimeType,
      dataUrl: attachments.dataUrl,
    })
    .from(attachments)
    .where(eq(attachments.threadId, id));

  return Response.json({ thread, messages: msgs, attachments: atts });
}

/**
 * DELETE /api/threads/[id] — スレッド削除。messages は cascade で消える。
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const [row] = await db.delete(threads).where(eq(threads.id, id)).returning();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}
