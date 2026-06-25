import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { skills } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/skills/[id] — スキル削除。
 * user_id でスコープし、他ユーザーのスキルは削除できない。
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const [row] = await db
    .delete(skills)
    .where(and(eq(skills.id, id), eq(skills.userId, user.id)))
    .returning();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}
