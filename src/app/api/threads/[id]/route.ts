import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, messages, threads, skills } from "@/db/schema";
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

  // Filter orphaned injectedSkills from message metadata.
  // When a skill is deleted, past messages still reference it via
  // metadata.injectedSkills. Query the user's current skill IDs once,
  // then strip entries whose skillId no longer exists.
  // The DB metadata is not modified — only the API response is cleaned.
  const skillRows = await db
    .select({ id: skills.id })
    .from(skills)
    .where(eq(skills.userId, user.id));
  const validSkillIds = new Set(skillRows.map((r) => r.id));

  const filteredMsgs = msgs.map((m) => {
    if (!m.metadata?.injectedSkills) return m;
    const filtered = m.metadata.injectedSkills.filter(
      (s: { skillId?: string }) => validSkillIds.has(s.skillId ?? ""),
    );
    if (filtered.length === m.metadata.injectedSkills.length) return m;
    return {
      ...m,
      metadata: {
        ...m.metadata,
        injectedSkills: filtered.length > 0 ? filtered : undefined,
      },
    };
  });

  // Cap individual message fields to 128KB (131072 chars) to prevent
  // browser crashes when a model hallucinates a huge output. Full content
  // remains in the DB for debugging — only the API response is truncated.
  const MAX_MSG_CHARS = 131072;
  const cappedMsgs = filteredMsgs.map((m) => {
    const cappedContent = m.content.length > MAX_MSG_CHARS
      ? m.content.slice(0, MAX_MSG_CHARS) + "\n...(truncated, original " + m.content.length + " chars)"
      : m.content;
    const cappedReasoning = m.reasoning && m.reasoning.length > MAX_MSG_CHARS
      ? m.reasoning.slice(0, MAX_MSG_CHARS) + "\n...(truncated, original " + m.reasoning.length + " chars)"
      : m.reasoning;
    return { ...m, content: cappedContent, reasoning: cappedReasoning };
  });
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

  return Response.json({ thread, messages: cappedMsgs, attachments: atts });
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
