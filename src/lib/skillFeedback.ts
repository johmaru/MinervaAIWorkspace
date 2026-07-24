import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { skills, skillUsageEvents } from "@/db/schema";
import { logger } from "@/lib/logger";

export type FeedbackOutcome = "helpful" | "not_helpful";

/**
 * Apply skill feedback in a single transaction.
 *
 * Updates the usage event outcome and adjusts lifetime success/failure
 * counters on the skill. Idempotent: re-submitting the same outcome is a no-op
 * (returns current counts). Toggling (helpful ↔ not_helpful) adjusts counters
 * by the delta.
 *
 * better-sqlite3 is a sync driver: transaction callback must be sync.
 *
 * @returns transaction result + shouldAttemptEvolution flag (true when the
 *   outcome just became not_helpful on an active skill — the caller decides
 *   whether to schedule an after() propose).
 */
export async function applySkillFeedback(args: {
  usageEventId: string;
  userId: string;
  outcome: FeedbackOutcome;
}): Promise<{
  eventId: string;
  outcome: FeedbackOutcome;
  skillId: string;
  successCount: number;
  failureCount: number;
  skillStatus: "active" | "archived";
  /** transaction succeeded and outcome is not_helpful on an active skill */
  shouldAttemptEvolution: boolean;
} | null> {
  const { usageEventId, userId, outcome } = args;

  const result = db.transaction((tx) => {
    const [event] = tx
      .select()
      .from(skillUsageEvents)
      .where(
        and(eq(skillUsageEvents.id, usageEventId), eq(skillUsageEvents.userId, userId)),
      )
      .limit(1)
      .all();

    if (!event) return null;

    // Idempotent: same outcome → no counter change.
    if (event.outcome === outcome) {
      // Still fetch skill counters for the response.
      const [skill] = tx
        .select({
          id: skills.id,
          successCount: skills.successCount,
          failureCount: skills.failureCount,
          status: skills.status,
        })
        .from(skills)
        .where(and(eq(skills.id, event.skillId), eq(skills.userId, userId)))
        .limit(1)
        .all();

      return {
        eventId: event.id,
        outcome,
        skillId: event.skillId,
        successCount: skill?.successCount ?? 0,
        failureCount: skill?.failureCount ?? 0,
        skillStatus: (skill?.status ?? "archived") as "active" | "archived",
        shouldAttemptEvolution: false,
      };
    }

    // Delta calculation (unknown → X, helpful ↔ not_helpful).
    let ds = 0;
    let df = 0;
    if (event.outcome === "unknown") {
      if (outcome === "helpful") ds = 1;
      else df = 1;
    } else if (event.outcome === "helpful" && outcome === "not_helpful") {
      ds = -1;
      df = 1;
    } else if (event.outcome === "not_helpful" && outcome === "helpful") {
      ds = 1;
      df = -1;
    }

    tx.update(skillUsageEvents)
      .set({ outcome })
      .where(
        and(eq(skillUsageEvents.id, usageEventId), eq(skillUsageEvents.userId, userId)),
      )
      .run();

    const [skill] = tx
      .update(skills)
      .set({
        successCount: sql`MAX(0, ${skills.successCount} + ${ds})`,
        failureCount: sql`MAX(0, ${skills.failureCount} + ${df})`,
        updatedAt: new Date(),
      })
      .where(and(eq(skills.id, event.skillId), eq(skills.userId, userId)))
      .returning({
        id: skills.id,
        successCount: skills.successCount,
        failureCount: skills.failureCount,
        status: skills.status,
      })
      .all();

    if (!skill) return null;

    return {
      eventId: event.id,
      outcome,
      skillId: event.skillId,
      successCount: skill.successCount,
      failureCount: skill.failureCount,
      skillStatus: skill.status as "active" | "archived",
      shouldAttemptEvolution: outcome === "not_helpful" && skill.status === "active",
    };
  });

  if (result) {
    logger.info("skill-feedback", "outcome recorded", {
      usageEventId,
      skillId: result.skillId,
      outcome,
      successCount: result.successCount,
      failureCount: result.failureCount,
    });
  }

  return result;
}
