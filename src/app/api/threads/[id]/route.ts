import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, threads } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/threads/[id] — スレッド本体 + 昇順メッセージ一覧。
 * Phase 2 は flat 線形会話（parent_id は未使用、Phase 5 でツリー化）。
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/threads/[id]">) {
  const { id } = await ctx.params;

  const [thread] = await db.select().from(threads).where(eq(threads.id, id));
  if (!thread) return new Response("Not found", { status: 404 });

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, id))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  return Response.json({ thread, messages: msgs });
}

/**
 * DELETE /api/threads/[id] — スレッド削除。messages は cascade で消える。
 */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/threads/[id]">) {
  const { id } = await ctx.params;
  const [row] = await db.delete(threads).where(eq(threads.id, id)).returning();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}
