import { eq, like, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { skills, skillUsageEvents } from "@/db/schema";
import { embedText } from "@/lib/embed";
import { toVecBuffer, distanceToSimilarity } from "@/lib/vectorSearch";
import { logger } from "@/lib/logger";

/**
 * Skill search and injection — per-user reusable prompts.
 *
 * While memories are ephemeral context fragments per thread, skills are
 * permanent cross-thread persona / behavior / knowledge.
 * Searches for relevant skills via client-side cosine similarity and injects them as system messages.
 * If the user says "use skill X", it is applied directly by name.
 */

export type ScoredSkill = {
  id: string;
  name: string;
  content: string;
  similarity: number;
};

/**
 * Searches for relevant skills by query string and user ID.
 *
 * 1. Vectorize the query via embedText(query, "query")
 * 2. SQL query with vec_distance_cosine (similarity > 0.3 = distance < 0.7)
 * 3. Return top-limit by similarity descending
 */
export async function findRelevantSkills(
  query: string,
  userId: string,
  limit = 5,
): Promise<ScoredSkill[]> {
  const queryVector = await embedText(query, "query");
  if (queryVector.length === 0) return [];
  const queryBuf = toVecBuffer(queryVector);

  const rows = await db.all(sql`
    SELECT id, name, content,
           vec_distance_cosine(embedding, ${queryBuf}) AS distance
    FROM skills
    WHERE user_id = ${userId}
      AND status = 'active'
      AND vec_distance_cosine(embedding, ${queryBuf}) < 0.7
    ORDER BY distance
    LIMIT ${limit}
  `) as { id: string; name: string; content: string; distance: number }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    content: r.content,
    similarity: Number(distanceToSimilarity(r.distance).toFixed(3)),
  }));
}

/**
 * Searches for relevant skills from user input and builds them as a system message.
 * Returns null if there are no skills (no injection).
 *
 * Manual skill specification (Phase 4):
 * If the user enters "use skill X" or a Japanese skill-use phrase, a partial match
 * search by name is performed and the matching skill is prepended.
 *
 * @param content User input
 * @param userId Skill owner
 */
export async function buildSkillContext({
  content,
  userId,
  threadId,
}: {
  content: string;
  userId: string;
  threadId?: string;
}): Promise<{ role: "system"; content: string } | null> {
  // Manual skill name extraction: Japanese skill-use pattern / "use X skill"
  const nameMatch =
    content.match(/(.+?)スキルを使っ(?:て|え)/) ??
    content.match(/use\s+(.+?)\s+skill/i);
  let namedSkill: ScoredSkill | undefined;
  if (nameMatch) {
    const name = nameMatch[1].trim();
    if (name) {
      // Partial match search by name. SQLite LIKE is case-insensitive by default.
      const pattern = `%${name.replace(/[%_]/g, "\\$&")}%`;
      const [found] = await db
        .select({ id: skills.id, name: skills.name, content: skills.content })
        .from(skills)
        .where(
          and(
            eq(skills.userId, userId),
            eq(skills.status, "active"),
            like(skills.name, pattern),
          ),
        )
        .limit(1);
      if (found) {
        namedSkill = {
          id: found.id,
          name: found.name,
          content: found.content,
          similarity: 1,
        };
      }
    }
  }

  // Semantic search
  const semantic = await findRelevantSkills(content, userId);

  // Prepend named skill (dedup)
  const seen = new Set<string>();
  const merged: ScoredSkill[] = [];
  if (namedSkill) {
    merged.push(namedSkill);
    seen.add(namedSkill.id);
  }
  for (const s of semantic) {
    if (!seen.has(s.id)) {
      merged.push(s);
      seen.add(s.id);
    }
  }

  // Skill usage log + lastUsedAt update (fire-and-forget)
  if (threadId && merged.length > 0) {
    const usageEntries = merged.map((s) => ({
      skillId: s.id,
      userId,
      threadId,
      similarity: s.similarity,
      activationType: (s.id === namedSkill?.id ? "manual" : "semantic") as "manual" | "semantic",
    }));
    db.insert(skillUsageEvents)
      .values(usageEntries)
        .catch((e) => logger.error("skill", "usage log failed", { error: e instanceof Error ? e.message : String(e) }));
    for (const s of merged) {
      db.update(skills)
        .set({ lastUsedAt: new Date() })
        .where(eq(skills.id, s.id))
        .catch((e) => logger.error("skill", "lastUsedAt update failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }
  if (merged.length === 0) return null;
  const lines = merged.map((s) => `- [${s.name}] ${s.content}`).join("\n");
  return {
    role: "system",
    content: `Active skills for this conversation. Follow these instructions:\n${lines}`,
  };
}
