import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { skillEvolutionProposals } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { applyEvolutionProposal } from "@/lib/skillEvolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PatchBody = {
  status: "approved" | "rejected";
  proposedContent?: string;
  proposedName?: string;
  proposedTrigger?: string;
  proposedTags?: string[];
};

/**
 * PATCH /api/skill-evolution-proposals/[id] — Approve or reject an evolution proposal.
 *
 * approve: calls applyEvolutionProposal (updateSkillContent + version bump + re-embed
 *          + lastEvolutionAt + supersede other drafts). Supports optional overrides
 *          for content/name/trigger/tags (user-editable before approve).
 * reject:  marks proposal as rejected.
 *
 * Status codes:
 *   401 unauthenticated
 *   404 proposal not found / wrong user
 *   409 proposal not draft / version conflict / skill archived
 *   400 unbounded edit
 *   503 embedding failed
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (body.status !== "approved" && body.status !== "rejected") {
    return new Response("Invalid status", { status: 400 });
  }

  if (body.status === "approved") {
    const overrides: {
      proposedContent?: string;
      proposedName?: string;
      proposedTrigger?: string;
      proposedTags?: string[];
    } = {};
    if (body.proposedContent !== undefined) overrides.proposedContent = body.proposedContent;
    if (body.proposedName !== undefined) overrides.proposedName = body.proposedName;
    if (body.proposedTrigger !== undefined) overrides.proposedTrigger = body.proposedTrigger;
    if (body.proposedTags !== undefined) {
      if (!Array.isArray(body.proposedTags) || !body.proposedTags.every((t: unknown) => typeof t === "string")) {
        return new Response("proposedTags must be an array of strings", { status: 400 });
      }
      overrides.proposedTags = body.proposedTags;
    }

    const result = await applyEvolutionProposal({
      proposalId: id,
      userId: user.id,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    });

    if ("error" in result) {
      return new Response(result.error, { status: result.status });
    }
    return Response.json(result);
  }

  // Reject
  const [row] = await db
    .update(skillEvolutionProposals)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(
      and(
        eq(skillEvolutionProposals.id, id),
        eq(skillEvolutionProposals.userId, user.id),
        eq(skillEvolutionProposals.status, "draft"),
      ),
    )
    .returning({ id: skillEvolutionProposals.id });

  if (!row) return new Response("Not found", { status: 404 });
  return Response.json({ id: row.id, status: "rejected" });
}

/**
 * DELETE /api/skill-evolution-proposals/[id] — Delete a draft proposal (physical delete).
 * Only drafts can be deleted. Approved/rejected/conflict proposals are not deletable.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const [row] = await db
    .delete(skillEvolutionProposals)
    .where(
      and(
        eq(skillEvolutionProposals.id, id),
        eq(skillEvolutionProposals.userId, user.id),
        eq(skillEvolutionProposals.status, "draft"),
      ),
    )
    .returning({ id: skillEvolutionProposals.id });

  if (!row) return new Response("Not found or not a draft", { status: 404 });
  return Response.json({ id: row.id });
}
