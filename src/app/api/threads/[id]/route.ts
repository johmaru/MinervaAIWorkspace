import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, messages, threads } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/threads/[id] — Thread body + message list (with branching info).
 *
 * Phase 5: Returns all messages, each including parentId.
 * The client traverses the parent chain to display the currentLeafId branch.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const [thread] = await db.select().from(threads).where(and(eq(threads.id, id), eq(threads.userId, user.id)));
  if (!thread) return new Response("Not found", { status: 404 });

  const msgs = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      parentId: messages.parentId,
      role: messages.role,
      content: messages.content,
      reasoning: messages.reasoning,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.threadId, id))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  // Fetch attachments (only those linked to a messageId)
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
 * DELETE /api/threads/[id] — Delete a thread. Messages are removed via cascade.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const [row] = await db.delete(threads).where(and(eq(threads.id, id), eq(threads.userId, user.id))).returning();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}
