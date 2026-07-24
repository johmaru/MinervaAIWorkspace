import { getSessionUser } from "@/lib/auth-guards";
import { applySkillFeedback, type FeedbackOutcome } from "@/lib/skillFeedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  outcome: FeedbackOutcome;
};

/**
 * POST /api/skill-usage/[id]/feedback — Record feedback on a skill usage event.
 *
 * Body: { "outcome": "helpful" | "not_helpful" }
 *
 * - 401 if unauthenticated
 * - 404 if event not found or belongs to another user (no enumeration leak)
 * - 400 if body is invalid
 *
 * Response:
 * {
 *   id: string;                    // usage event id
 *   outcome: "helpful" | "not_helpful";
 *   skill: { id: string; successCount: number; failureCount: number };
 *   evolutionTriggered: boolean;   // always false in PR1 (evolution after() added in PR4)
 * }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { id } = await ctx.params;

  let body: Body;
  try {
    const parsed = await req.json();
    if (parsed?.outcome !== "helpful" && parsed?.outcome !== "not_helpful") {
      return new Response("Invalid outcome", { status: 400 });
    }
    body = parsed as Body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const result = await applySkillFeedback({
    usageEventId: id,
    userId: user.id,
    outcome: body.outcome,
  });

  if (!result) return new Response("Not found", { status: 404 });

  return Response.json({
    id: result.eventId,
    outcome: result.outcome,
    skill: {
      id: result.skillId,
      successCount: result.successCount,
      failureCount: result.failureCount,
    },
    // PR1: evolution after() is not wired yet. Always false until PR4.
    evolutionTriggered: false,
  });
}
