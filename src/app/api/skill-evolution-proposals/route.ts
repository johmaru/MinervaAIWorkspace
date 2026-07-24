import { and, eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { skillEvolutionProposals, skills } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProposalStatus = "draft" | "approved" | "rejected" | "superseded" | "conflict";

/**
 * GET /api/skill-evolution-proposals — List evolution proposals for the logged-in user.
 *
 * Query params:
 *   status: draft (default) | approved | rejected | superseded | conflict
 *   limit:  1–100 (default 100)
 *
 * Returns proposals joined with skill name for display.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const validStatuses: ProposalStatus[] = ["draft", "approved", "rejected", "superseded", "conflict"];
  const status: ProposalStatus = validStatuses.includes(statusParam as ProposalStatus)
    ? (statusParam as ProposalStatus)
    : "draft";
  const limitParam = parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(Math.max(1, limitParam || 100), 100);

  const rows = await db
    .select({
      id: skillEvolutionProposals.id,
      skillId: skillEvolutionProposals.skillId,
      skillName: skills.name,
      baseVersion: skillEvolutionProposals.baseVersion,
      previousContent: skillEvolutionProposals.previousContent,
      proposedContent: skillEvolutionProposals.proposedContent,
      proposedName: skillEvolutionProposals.proposedName,
      proposedTrigger: skillEvolutionProposals.proposedTrigger,
      proposedTags: skillEvolutionProposals.proposedTags,
      patchSummary: skillEvolutionProposals.patchSummary,
      reason: skillEvolutionProposals.reason,
      evidenceEventIds: skillEvolutionProposals.evidenceEventIds,
      contentHash: skillEvolutionProposals.contentHash,
      status: skillEvolutionProposals.status,
      appliedVersion: skillEvolutionProposals.appliedVersion,
      createdAt: skillEvolutionProposals.createdAt,
      updatedAt: skillEvolutionProposals.updatedAt,
    })
    .from(skillEvolutionProposals)
    .leftJoin(skills, eq(skillEvolutionProposals.skillId, skills.id))
    .where(
      and(
        eq(skillEvolutionProposals.userId, user.id),
        eq(skillEvolutionProposals.status, status),
      ),
    )
    .orderBy(desc(skillEvolutionProposals.createdAt))
    .limit(limit);

  return Response.json(rows);
}
