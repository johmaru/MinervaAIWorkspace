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
 * DELETE /api/global-instructions/[id] — Delete a named global instruction.
 * Via ON DELETE SET NULL, if the deleted row was active/global,
 * users.activeInstructionId / threads.globalInstructionId are automatically set to null.
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
 * PATCH /api/global-instructions/[id] — Partial update of a named global instruction.
 * name must not be empty (returns 400 if empty). content allows empty (effectively disables it).
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
