import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { skillCandidates, skills } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PatchBody = {
  status?: "approved" | "rejected";
  // Override fields for Edit & Approve
  proposedName?: string;
  proposedKind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  proposedTrigger?: string;
  proposedTags?: string[];
  proposedContent?: string;
  // When duplicateOfId is set and status="approved", update the existing skill instead of creating a new one.
  // mergeAction: "replace" = overwrite content, "append" = append to existing content.
  mergeAction?: "replace" | "append";
};

/**
 * PATCH /api/skill-candidates/[id] — Approve/reject a candidate.
 * When status="approved":
 *   1. Compute embedding from candidate fields (overridable)
 *   2. Insert into the skills table
 *   3. Update the candidate's status to "approved"
 *   4. Return the new skill
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

  // Fetch candidate (user scope)
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

  // approved: resolve override fields
  const name = body.proposedName?.trim() || candidate.proposedName;
  const content = body.proposedContent?.trim() || candidate.proposedContent;
  const kind = body.proposedKind || candidate.proposedKind;
  const trigger = body.proposedTrigger?.trim() || candidate.proposedTrigger;
  const tags = body.proposedTags
    ? body.proposedTags.filter((t): t is string => typeof t === "string")
    : candidate.proposedTags;

  // If the candidate was flagged as a semantic duplicate of an existing skill,
  // and the user chose to update the existing skill (mergeAction set),
  // replace or append the existing skill's content instead of creating a new skill.
  // This runs before the embedding call to avoid a wasted API call.
  if (candidate.duplicateOfId && candidate.duplicateOfType === "skill" && body.mergeAction) {
    const [existing] = await db
      .select()
      .from(skills)
      .where(and(eq(skills.id, candidate.duplicateOfId), eq(skills.userId, user.id)))
      .limit(1);
    // Referenced skill was deleted (e.g., during a consolidation).
    // Clear the stale reference and fall through to normal approve below.
    if (!existing) {
      await db
        .update(skillCandidates)
        .set({ duplicateOfId: null, duplicateOfType: null, updatedAt: new Date() })
        .where(eq(skillCandidates.id, id));
      candidate.duplicateOfId = null;
      candidate.duplicateOfType = null;
      // Fall through to normal approve (create new skill).
    } else {
      const mergedContent =
        body.mergeAction === "append"
          ? `${existing.content}\n\n${content}`
          : content;
      const mergedName = body.proposedName?.trim() || existing.name;
      const mergedKind = body.proposedKind || existing.kind;
      const mergedTrigger = body.proposedTrigger?.trim() || existing.trigger || "";
      const mergedTags = body.proposedTags
        ? body.proposedTags.filter((t): t is string => typeof t === "string")
        : existing.tags;

      const mergedEmbedSource = [mergedName, mergedTrigger, mergedTags.join(", "), mergedContent]
        .filter(Boolean).join("\n");
      const mergedVector = await embedText(mergedEmbedSource, "document");
      if (mergedVector.length === 0) {
        return new Response("Embedding failed", { status: 503 });
      }
      const mergedHash = hashContent(mergedContent);

      const [updated] = await db
        .update(skills)
        .set({
          name: mergedName,
          content: mergedContent,
          embedding: mergedVector,
          contentHash: mergedHash,
          kind: mergedKind,
          trigger: mergedTrigger,
          tags: mergedTags,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(skills.id, existing.id), eq(skills.userId, user.id)))
        .returning({
          id: skills.id,
          name: skills.name,
          content: skills.content,
          kind: skills.kind,
          trigger: skills.trigger,
          tags: skills.tags,
        });

      await db
        .update(skillCandidates)
        .set({ status: "merged", updatedAt: new Date() })
        .where(eq(skillCandidates.id, id));

      return Response.json({ candidate: { id, status: "merged" }, skill: updated });
    }
  }

  // Normal approve: generate embedding for the new skill
  const embedSource = [name, trigger, tags.join(", "), content].filter(Boolean).join("\n");
  const vector = await embedText(embedSource, "document");
  if (vector.length === 0) {
    return new Response("Embedding failed", { status: 503 });
  }
  const contentHash = hashContent(content);

  // contentHash duplicate check
  const [dup] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.userId, user.id), eq(skills.contentHash, contentHash)))
    .limit(1);
  if (dup) {
    // Duplicate of existing skill → update candidate to merged
    await db
      .update(skillCandidates)
      .set({ status: "merged", updatedAt: new Date() })
      .where(eq(skillCandidates.id, id));
    return Response.json({ id, status: "merged", reason: "duplicate skill exists" });
  }

  // Insert into skills table
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

  // Update candidate to approved
  await db
    .update(skillCandidates)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(skillCandidates.id, id));

  return Response.json({ candidate: { id, status: "approved" }, skill });
}

/**
 * DELETE /api/skill-candidates/[id] — Physical delete of a draft candidate.
 * Scoped by user_id. approved/rejected cannot be deleted (status change only).
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
