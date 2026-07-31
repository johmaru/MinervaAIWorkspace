// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, threads, skills, skillUsageEvents } from "@/db/schema";
import { hashContent } from "@/lib/embed";
import { applySkillFeedback } from "@/lib/skillFeedback";

const createdUserIds: string[] = [];
const createdThreadIds: string[] = [];
const createdSkillIds: string[] = [];
const createdEventIds: string[] = [];

let userId: string;
let threadId: string;

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ nickname: "skillFeedback-test", email: "skillfb-test@minerva.test" })
    .returning();
  userId = user.id;
  createdUserIds.push(user.id);

  const [thread] = await db
    .insert(threads)
    .values({ title: "skillFeedback test", userId })
    .returning();
  threadId = thread.id;
  createdThreadIds.push(thread.id);
});

afterAll(async () => {
  for (const id of createdEventIds) {
    await db.delete(skillUsageEvents).where(eq(skillUsageEvents.id, id));
  }
  for (const id of createdSkillIds) {
    await db.delete(skills).where(eq(skills.id, id));
  }
  for (const id of createdThreadIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

async function createSkill(name: string, status: "active" | "archived" = "active"): Promise<string> {
  const [skill] = await db
    .insert(skills)
    .values({
      name,
      content: `content for ${name}`,
      embedding: [],
      contentHash: hashContent(`content for ${name}`),
      status,
      userId,
    })
    .returning();
  createdSkillIds.push(skill.id);
  return skill.id;
}

async function createUsageEvent(skillId: string): Promise<string> {
  const [event] = await db
    .insert(skillUsageEvents)
    .values({
      skillId,
      userId,
      threadId,
      similarity: 0.5,
      activationType: "semantic",
    })
    .returning();
  createdEventIds.push(event.id);
  return event.id;
}

describe("applySkillFeedback", () => {
  it("records helpful outcome and increments successCount", async () => {
    const skillId = await createSkill("helpful-skill");
    const eventId = await createUsageEvent(skillId);

    const result = await applySkillFeedback({
      usageEventId: eventId,
      userId,
      outcome: "helpful",
    });

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("helpful");
    expect(result!.successCount).toBe(1);
    expect(result!.failureCount).toBe(0);
    expect(result!.shouldAttemptEvolution).toBe(false);
  });

  it("records not_helpful outcome and increments failureCount", async () => {
    const skillId = await createSkill("unhelpful-skill");
    const eventId = await createUsageEvent(skillId);

    const result = await applySkillFeedback({
      usageEventId: eventId,
      userId,
      outcome: "not_helpful",
    });

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("not_helpful");
    expect(result!.successCount).toBe(0);
    expect(result!.failureCount).toBe(1);
    expect(result!.shouldAttemptEvolution).toBe(true);
  });

  it("is idempotent when same outcome is submitted twice", async () => {
    const skillId = await createSkill("idempotent-skill");
    const eventId = await createUsageEvent(skillId);

    await applySkillFeedback({ usageEventId: eventId, userId, outcome: "helpful" });
    const result = await applySkillFeedback({
      usageEventId: eventId,
      userId,
      outcome: "helpful",
    });

    expect(result).not.toBeNull();
    expect(result!.successCount).toBe(1);
    expect(result!.shouldAttemptEvolution).toBe(false);
  });

  it("toggles from helpful to not_helpful with correct deltas", async () => {
    const skillId = await createSkill("toggle-skill");
    const eventId = await createUsageEvent(skillId);

    await applySkillFeedback({ usageEventId: eventId, userId, outcome: "helpful" });
    const result = await applySkillFeedback({
      usageEventId: eventId,
      userId,
      outcome: "not_helpful",
    });

    expect(result).not.toBeNull();
    expect(result!.successCount).toBe(0);
    expect(result!.failureCount).toBe(1);
    expect(result!.shouldAttemptEvolution).toBe(true);
  });

  it("toggles from not_helpful to helpful with correct deltas", async () => {
    const skillId = await createSkill("toggle-back-skill");
    const eventId = await createUsageEvent(skillId);

    await applySkillFeedback({ usageEventId: eventId, userId, outcome: "not_helpful" });
    const result = await applySkillFeedback({
      usageEventId: eventId,
      userId,
      outcome: "helpful",
    });

    expect(result).not.toBeNull();
    expect(result!.successCount).toBe(1);
    expect(result!.failureCount).toBe(0);
    expect(result!.shouldAttemptEvolution).toBe(false);
  });

  it("returns null for non-existent event", async () => {
    const result = await applySkillFeedback({
      usageEventId: "nonexistent-event-id",
      userId,
      outcome: "helpful",
    });
    expect(result).toBeNull();
  });

  it("returns null for another user's event (userId isolation)", async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ nickname: "other-user", email: "other-skillfb@minerva.test" })
      .returning();
    createdUserIds.push(otherUser.id);

    const skillId = await createSkill("isolation-skill");
    const eventId = await createUsageEvent(skillId);

    const result = await applySkillFeedback({
      usageEventId: eventId,
      userId: otherUser.id,
      outcome: "helpful",
    });

    expect(result).toBeNull();
  });

  it("does not set shouldAttemptEvolution for archived skill", async () => {
    const skillId = await createSkill("archived-skill", "archived");
    const eventId = await createUsageEvent(skillId);

    const result = await applySkillFeedback({
      usageEventId: eventId,
      userId,
      outcome: "not_helpful",
    });

    expect(result).not.toBeNull();
    expect(result!.failureCount).toBe(1);
    expect(result!.shouldAttemptEvolution).toBe(false);
  });
});
