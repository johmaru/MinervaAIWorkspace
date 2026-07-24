import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { skills } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { updateSkillContent } from "@/lib/skillStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PatchBody = {
  name?: string;
  content?: string;
  kind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  trigger?: string;
  tags?: string[];
  status?: "active" | "archived";
};

/**
 * PATCH /api/skills/[id] — Edit a skill.
 * Partially updates name/content/kind/trigger/tags/status.
 * Re-embeds + updates contentHash + increments version when content changes.
 * Uses shared updateSkillContent helper for embed/version/hash logic.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  let body: PatchBody = {};
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Fetch existing skill (user scope) — needed for kind update which
  // updateSkillContent doesn't handle (kind is not in its patch type)
  const [existing] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), eq(skills.userId, user.id)))
    .limit(1);
  if (!existing) return new Response("Not found", { status: 404 });

  // Handle kind separately (not part of updateSkillContent)
  if (body.kind !== undefined) {
    await db
      .update(skills)
      .set({ kind: body.kind, updatedAt: new Date() })
      .where(and(eq(skills.id, id), eq(skills.userId, user.id)));
  }

  // Use shared helper for content/name/trigger/tags/status
  const patch: {
    content?: string;
    name?: string;
    trigger?: string;
    tags?: string[];
    status?: "active" | "archived";
  } = {};

  if (body.content !== undefined) patch.content = body.content;
  if (body.name !== undefined) patch.name = body.name;
  if (body.trigger !== undefined) patch.trigger = body.trigger;
  if (body.tags !== undefined) {
    patch.tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : [];
  }
  if (body.status !== undefined) patch.status = body.status;

  // Only call updateSkillContent if there's something to update beyond kind
  const hasContentUpdate =
    body.content !== undefined ||
    body.name !== undefined ||
    body.trigger !== undefined ||
    body.tags !== undefined ||
    body.status !== undefined;

  if (hasContentUpdate) {
    const row = await updateSkillContent(id, user.id, patch);
    if (!row) {
      // updateSkillContent returns null on embedding failure OR not found.
      // We already verified the skill exists above, so null means embedding failed.
      return new Response("Embedding failed", { status: 503 });
    }
    return Response.json(row);
  }

  // Only kind was updated — return existing skill fields
  const [updated] = await db
    .select({
      id: skills.id,
      name: skills.name,
      content: skills.content,
      kind: skills.kind,
      trigger: skills.trigger,
      tags: skills.tags,
      status: skills.status,
      version: skills.version,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(and(eq(skills.id, id), eq(skills.userId, user.id)))
    .limit(1);
  if (!updated) return new Response("Not found", { status: 404 });
  return Response.json(updated);
}

/**
 * DELETE /api/skills/[id] — Delete a skill.
 * Scoped by user_id; cannot delete another user's skill.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const [row] = await db
    .delete(skills)
    .where(and(eq(skills.id, id), eq(skills.userId, user.id)))
    .returning({ id: skills.id });
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json({ id: row.id });
}
