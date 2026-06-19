import { eq } from "drizzle-orm";
import { db } from "@/db";
import { folders } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/folders/[id] — フォルダ削除。
 * 紐づく threads.folderId は ON DELETE SET NULL で null 化される。
 * メッセージ・embedding は残る（メモリは消えない）。
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const [row] = await db.delete(folders).where(eq(folders.id, id)).returning();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}
