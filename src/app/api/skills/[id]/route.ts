import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { skills } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";

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
 * PATCH /api/skills/[id] — スキル編集。
 * name/content/kind/trigger/tags/status を部分更新。
 * content 変更時は re-embed + contentHash 更新 + version インクリメント。
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

  // 既存スキル取得（user scope）
  const [existing] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), eq(skills.userId, user.id)))
    .limit(1);
  if (!existing) return new Response("Not found", { status: 404 });

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.kind !== undefined) updates.kind = body.kind;
  if (body.trigger !== undefined) updates.trigger = body.trigger.trim();
  if (body.tags !== undefined) {
    updates.tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : [];
  }
  if (body.status !== undefined) updates.status = body.status;

  // embedding ソース（name + trigger + tags + content）のいずれかが変わったら re-embed。
  // contentHash + version は content 変更時のみ bump。
  const newContent = body.content?.trim();
  const newName = (updates.name as string | undefined) ?? existing.name;
  const newTrigger = (updates.trigger as string | undefined) ?? existing.trigger ?? "";
  const newTags = (updates.tags as string[] | undefined) ?? existing.tags;
  const contentChanged = newContent !== undefined && newContent !== existing.content;
  const nameChanged = updates.name !== undefined;
  const triggerChanged = updates.trigger !== undefined;
  const tagsChanged = updates.tags !== undefined;

  if (contentChanged || nameChanged || triggerChanged || tagsChanged) {
    const effectiveContent = newContent ?? existing.content;
    const embedSource = [newName, newTrigger, newTags.join(", "), effectiveContent]
      .filter(Boolean)
      .join("\n");
    const vector = await embedText(embedSource, "document");
    if (vector.length === 0) {
      return new Response("Embedding failed", { status: 503 });
    }
    updates.embedding = vector;
    if (contentChanged) {
      updates.content = newContent;
      updates.contentHash = hashContent(newContent);
      updates.version = existing.version + 1;
    }
  }

  const [row] = await db
    .update(skills)
    .set(updates)
    .where(and(eq(skills.id, id), eq(skills.userId, user.id)))
    .returning({
      id: skills.id,
      name: skills.name,
      content: skills.content,
      kind: skills.kind,
      trigger: skills.trigger,
      tags: skills.tags,
      status: skills.status,
      version: skills.version,
      updatedAt: skills.updatedAt,
    });
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}

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
