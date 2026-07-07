import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { skillCandidates } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/skill-candidates — ログインユーザーのスキル候補一覧。
 * ?status=draft|approved|rejected|merged でフィルタ（デフォルト: draft）。
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const validStatuses = ["draft", "approved", "rejected", "merged"] as const;
  const status =
    statusParam && (validStatuses as readonly string[]).includes(statusParam)
      ? (statusParam as (typeof validStatuses)[number])
      : "draft";

  const rows = await db
    .select({
      id: skillCandidates.id,
      threadId: skillCandidates.threadId,
      proposedName: skillCandidates.proposedName,
      proposedKind: skillCandidates.proposedKind,
      proposedTrigger: skillCandidates.proposedTrigger,
      proposedContent: skillCandidates.proposedContent,
      proposedTags: skillCandidates.proposedTags,
      confidence: skillCandidates.confidence,
      reason: skillCandidates.reason,
      status: skillCandidates.status,
      createdAt: skillCandidates.createdAt,
      updatedAt: skillCandidates.updatedAt,
    })
    .from(skillCandidates)
    .where(and(eq(skillCandidates.userId, user.id), eq(skillCandidates.status, status)))
    .orderBy(desc(skillCandidates.createdAt));
  return Response.json(rows);
}
