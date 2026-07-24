import { getSessionUser } from "@/lib/auth-guards";
import { maybeProposeSkillEvolution, isSkillEvolutionEnabled } from "@/lib/skillEvolution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  force?: boolean;
};

/**
 * POST /api/skills/[id]/evolve — Manually trigger skill evolution proposal.
 *
 * Body: { "force"?: boolean }
 *
 * - 401 unauthenticated
 * - 404 skill not found
 * - 409 open draft exists (force won't override — client should review existing draft)
 * - 429 force rate limited (5 min) — only when force=true
 * - 201 proposal created
 * - 200 no-op (threshold/cooldown not met) with { triggered: false, reason }
 *
 * Normal: checks window threshold + cooldown + open draft.
 * force=true: skips threshold, but still checks 5 min rate limit + open draft.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { id } = await ctx.params;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // Body is optional — empty body is fine
  }

  if (!isSkillEvolutionEnabled()) {
    return new Response("Skill evolution is disabled", { status: 503 });
  }

  const result = await maybeProposeSkillEvolution({
    skillId: id,
    userId: user.id,
    force: body.force,
  });

  // Handle rejection cases
  if (result.reason === "open_draft_exists") {
    return Response.json(
      { error: "open_draft_exists", proposalId: result.proposalId },
      { status: 409 },
    );
  }

  if (result.reason === "force_rate_limited") {
    return Response.json({ error: "force_rate_limited" }, { status: 429 });
  }

  if (result.reason === "skill_not_found") {
    return new Response("Not found", { status: 404 });
  }

  if (result.reason === "skill_archived") {
    return Response.json({ error: "skill_archived" }, { status: 409 });
  }

  // Proposal created
  if (result.proposed) {
    return Response.json(
      { proposalId: result.proposalId, triggered: true },
      { status: 201 },
    );
  }

  // Threshold not met, cooldown, or other no-op
  return Response.json({ triggered: false, reason: result.reason });
}
