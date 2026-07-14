import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userTraits } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/user-traits/[id] — Soft delete a trait.
 * Sets suppressedAt (not a physical delete). Same pattern as memories.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const [row] = await db
    .select({ id: userTraits.id })
    .from(userTraits)
    .where(and(eq(userTraits.id, id), eq(userTraits.userId, user.id)))
    .limit(1);
  if (!row) return new Response("Not found", { status: 404 });
  await db
    .update(userTraits)
    .set({ suppressedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(userTraits.id, id), eq(userTraits.userId, user.id)));
  return new Response(null, { status: 204 });
}

type PatchBody = {
  content?: string;
  category?: "demographic" | "interest" | "speech_pattern" | "preference";
};

/**
 * PATCH /api/user-traits/[id] — Partial trait update.
 * Regenerates embedding + contentHash when content changes.
 * Does not touch confidence / evidenceCount.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const [existing] = await db
    .select({ id: userTraits.id })
    .from(userTraits)
    .where(and(eq(userTraits.id, id), eq(userTraits.userId, user.id)))
    .limit(1);
  if (!existing) return new Response("Not found", { status: 404 });

  let body: PatchBody = {};
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (body.content !== undefined) {
    const content = body.content.trim();
    if (!content) return new Response("content cannot be empty", { status: 400 });
    const vector = await embedText(content, "document");
    if (vector.length === 0) return new Response("Embedding failed", { status: 503 });
    updates.content = content;
    updates.embedding = vector;
    updates.contentHash = hashContent(content);
  }

  if (body.category !== undefined) {
    const validCategories = ["demographic", "interest", "speech_pattern", "preference"] as const;
    if (!validCategories.includes(body.category)) {
      return new Response("Invalid category", { status: 400 });
    }
    updates.category = body.category;
  }

  await db.update(userTraits).set(updates).where(and(eq(userTraits.id, id), eq(userTraits.userId, user.id)));
  return new Response(null, { status: 204 });
}
