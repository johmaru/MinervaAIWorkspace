import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { folders } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/folders/[id] — Delete a folder.
 * Associated threads.folderId is set to null via ON DELETE SET NULL.
 * Messages and embeddings remain (memories are not lost).
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const [row] = await db.delete(folders).where(and(eq(folders.id, id), eq(folders.userId, user.id))).returning();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}
