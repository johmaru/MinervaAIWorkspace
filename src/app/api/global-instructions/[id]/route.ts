import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { globalInstructions } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PatchBody = {
  name?: string;
  content?: string;
};

/**
 * DELETE /api/global-instructions/[id] — 名前付きグローバルインストラクション削除。
 * ON DELETE SET NULL により、削除された行が active/global だった場合は
 * users.activeInstructionId / threads.globalInstructionId は自動的に null になる。
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const [row] = await db
    .delete(globalInstructions)
    .where(and(eq(globalInstructions.id, id), eq(globalInstructions.userId, user.id)))
    .returning();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}

/**
 * PATCH /api/global-instructions/[id] — 名前付きグローバルインストラクション部分更新。
 * name は空を許さず（空なら400）。content は空も許可（実質無効化）。
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

  const values: Partial<typeof globalInstructions.$inferInsert> = { updatedAt: new Date() };
  if (typeof body.name === "string") {
    const n = body.name.trim();
    if (!n) return new Response("name must not be empty", { status: 400 });
    values.name = n;
  }
  if (typeof body.content === "string") {
    values.content = body.content.trim();
  }

  const [row] = await db
    .update(globalInstructions)
    .set(values)
    .where(and(eq(globalInstructions.id, id), eq(globalInstructions.userId, user.id)))
    .returning({
      id: globalInstructions.id,
      name: globalInstructions.name,
      content: globalInstructions.content,
    });
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}
