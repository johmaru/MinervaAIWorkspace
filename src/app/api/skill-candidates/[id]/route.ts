import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { skillCandidates, skills } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PatchBody = {
  status?: "approved" | "rejected";
  // Edit & Approve 用の上書きフィールド
  proposedName?: string;
  proposedKind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  proposedTrigger?: string;
  proposedTags?: string[];
  proposedContent?: string;
};

/**
 * PATCH /api/skill-candidates/[id] — 候補の承認/却下。
 * status="approved" の場合:
 *   1. 候補フィールド（上書き可）から embedding を計算
 *   2. skills テーブルに挿入
 *   3. 候補の status を "approved" に更新
 *   4. 新しいスキルを返す
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

  if (!body.status || !["approved", "rejected"].includes(body.status)) {
    return new Response("status must be 'approved' or 'rejected'", { status: 400 });
  }

  // 候補取得（user scope）
  const [candidate] = await db
    .select()
    .from(skillCandidates)
    .where(and(eq(skillCandidates.id, id), eq(skillCandidates.userId, user.id)))
    .limit(1);
  if (!candidate) return new Response("Not found", { status: 404 });

  if (body.status === "rejected") {
    await db
      .update(skillCandidates)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(skillCandidates.id, id));
    return Response.json({ id, status: "rejected" });
  }

  // approved: skills テーブルに昇格
  const name = body.proposedName?.trim() || candidate.proposedName;
  const content = body.proposedContent?.trim() || candidate.proposedContent;
  const kind = body.proposedKind || candidate.proposedKind;
  const trigger = body.proposedTrigger?.trim() || candidate.proposedTrigger;
  const tags = body.proposedTags
    ? body.proposedTags.filter((t): t is string => typeof t === "string")
    : candidate.proposedTags;

  // embedding 生成: name + trigger + tags + content
  const embedSource = [name, trigger, tags.join(", "), content].filter(Boolean).join("\n");
  const vector = await embedText(embedSource, "document");
  if (vector.length === 0) {
    return new Response("Embedding failed", { status: 503 });
  }
  const contentHash = hashContent(content);

  // contentHash 重複チェック
  const [dup] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.userId, user.id), eq(skills.contentHash, contentHash)))
    .limit(1);
  if (dup) {
    // 既存スキルと重複 → 候補を merged に更新
    await db
      .update(skillCandidates)
      .set({ status: "merged", updatedAt: new Date() })
      .where(eq(skillCandidates.id, id));
    return Response.json({ id, status: "merged", reason: "duplicate skill exists" });
  }

  // skills テーブルに挿入
  const [skill] = await db
    .insert(skills)
    .values({
      userId: user.id,
      name,
      content,
      embedding: vector,
      contentHash,
      kind,
      trigger,
      tags,
      sourceThreadId: candidate.threadId,
    })
    .returning({
      id: skills.id,
      name: skills.name,
      content: skills.content,
      kind: skills.kind,
      trigger: skills.trigger,
      tags: skills.tags,
    });

  // 候補を approved に更新
  await db
    .update(skillCandidates)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(skillCandidates.id, id));

  return Response.json({ candidate: { id, status: "approved" }, skill });
}

/**
 * DELETE /api/skill-candidates/[id] — ドラフト候補の物理削除。
 * user_id でスコープ。approved/rejected は削除不可（status 変更のみ）。
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const [row] = await db
    .delete(skillCandidates)
    .where(and(eq(skillCandidates.id, id), eq(skillCandidates.userId, user.id)))
    .returning();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}
