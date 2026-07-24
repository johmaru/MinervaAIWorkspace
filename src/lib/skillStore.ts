import { and, eq, like, inArray, sql, desc } from "drizzle-orm";
import { db } from "@/db";
import { skills, skillUsageEvents } from "@/db/schema";
import { embedText, hashContent } from "@/lib/embed";
import { toVecBuffer, distanceToSimilarity } from "@/lib/vectorSearch";
import { logger } from "@/lib/logger";

/**
 * Skill search and injection — per-user reusable prompts.
 *
 * While memories are ephemeral context fragments per thread, skills are
 * permanent cross-thread persona / behavior / knowledge.
 * Searches for relevant skills via SQL vec_distance_cosine and injects them as system messages.
 * If the user says "use skill X", it is applied directly by name.
 */

export type ScoredSkill = {
  id: string;
  name: string;
  content: string;
  similarity: number;
};

/** Skill Evolution: info about an injected skill, persisted in messages.metadata.injectedSkills */
export type InjectedSkillInfo = {
  skillId: string;
  name: string;
  usageEventId: string;
  similarity: number;
  activationType: "semantic" | "manual";
};

/** Result of buildSkillContext — message for LLM context + injected skill metadata */
export type SkillContextResult = {
  message: { role: "system"; content: string };
  injected: InjectedSkillInfo[];
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
}): Promise<SkillContextResult | null> {
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

  if (merged.length === 0) return null;

  // Skill usage log: multi-row insert + RETURNING (await — usageEventId is required
  // for feedback and metadata persistence). Single lastUsedAt UPDATE via IN clause.
  if (merged.length === 0) return null;

  let injected: InjectedSkillInfo[] = [];
  if (threadId) {
    const usageEntries = merged.map((s) => ({
      skillId: s.id,
      userId,
      threadId,
      similarity: s.similarity,
      activationType: (s.id === namedSkill?.id ? "manual" : "semantic") as "manual" | "semantic",
    }));
    try {
      const rows = await db
        .insert(skillUsageEvents)
        .values(usageEntries)
        .returning({
          id: skillUsageEvents.id,
          skillId: skillUsageEvents.skillId,
        });
      // Build injected info by joining returned usage event ids with skill metadata.
      injected = merged
        .map((s) => {
          const row = rows.find((r) => r.skillId === s.id);
          if (!row) return null;
          return {
            skillId: s.id,
            name: s.name,
            usageEventId: row.id,
            similarity: s.similarity,
            activationType: (s.id === namedSkill?.id ? "manual" : "semantic") as "manual" | "semantic",
          };
        })
        .filter((x): x is InjectedSkillInfo => x !== null);
      db.update(skills)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(skills.userId, userId), inArray(skills.id, merged.map((s) => s.id))))
        .catch((e) => logger.error("skill", "lastUsedAt update failed", { error: e instanceof Error ? e.message : String(e) }));
    } catch (e) {
      logger.error("skill", "usage log insert failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  const lines = merged.map((s) => `- [${s.name}] ${s.content}`).join("\n");
  return {
    message: {
      role: "system",
      content: `Active skills for this conversation. Follow these instructions:\n${lines}`,
    },
    injected,
  };
}

/**
 * Attach messageId to skill usage events after the assistant message is saved.
 * Called on both success and partial-error save paths so feedback evidence is
 * always linked to a message.
 */
export async function attachUsageMessageIds(
  usageEventIds: string[],
  messageId: string,
  userId: string,
): Promise<void> {
  if (usageEventIds.length === 0) return;
  try {
    await db
      .update(skillUsageEvents)
      .set({ messageId })
      .where(
        and(
          eq(skillUsageEvents.userId, userId),
          inArray(skillUsageEvents.id, usageEventIds),
        ),
      );
  } catch (e) {
    logger.error("skill", "attachUsageMessageIds failed", {
      messageId,
      count: usageEventIds.length,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Shared skill content update helper — used by PATCH /api/skills/[id].
 * applyEvolutionProposal performs its own transactional update (version bump +
 * re-embed + lastEvolutionAt) and does not call this helper directly.
 *
 * Embed source: [name, trigger, tags.join(", "), content].filter(Boolean).join("\n")
 * Re-embeds + updates contentHash + increments version when content changes.
 * Returns the updated skill row or null if not found or embedding failed.
 */
export async function updateSkillContent(
  skillId: string,
  userId: string,
  patch: {
    content?: string;
    name?: string;
    trigger?: string;
    tags?: string[];
    status?: "active" | "archived";
  },
): Promise<{ id: string; version: number; content: string; name: string; contentHash: string } | { error: "embed_failed" } | { error: "version_conflict" } | null> {
  const [existing] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, skillId), eq(skills.userId, userId)))
    .limit(1);
  if (!existing) return null;

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.name !== undefined) updates.name = patch.name.trim();
  if (patch.trigger !== undefined) updates.trigger = patch.trigger.trim();
  if (patch.tags !== undefined) {
    updates.tags = Array.isArray(patch.tags)
      ? patch.tags.filter((t): t is string => typeof t === "string")
      : [];
  }
  if (patch.status !== undefined) updates.status = patch.status;

  const newContent = patch.content?.trim();
  const newName = (updates.name as string | undefined) ?? existing.name;
  const newTrigger = (updates.trigger as string | undefined) ?? existing.trigger ?? "";
  const newTags = (updates.tags as string[] | undefined) ?? existing.tags;
  const contentChanged = newContent !== undefined && newContent !== existing.content;
  const nameChanged = updates.name !== undefined;
  const triggerChanged = updates.trigger !== undefined;
  const tagsChanged = updates.tags !== undefined;

  if (contentChanged || nameChanged || triggerChanged || tagsChanged) {
    const effectiveContent = newContent ?? existing.content;
    const embedSource = [newName, newTrigger, newTags.join(", "), effectiveContent]
      .filter(Boolean)
      .join("\n");
    const vector = await embedText(embedSource, "document");
    if (vector.length === 0) {
      return { error: "embed_failed" as const };
    }
    // Guard against degenerate embeddings (identical vector for different
    // content). Compare against another skill with a different contentHash.
    const newHash = contentChanged ? hashContent(newContent!) : existing.contentHash;
    const [other] = await db
      .select({ embedding: skills.embedding, contentHash: skills.contentHash })
      .from(skills)
      .where(and(
        eq(skills.userId, userId),
        eq(skills.status, "active"),
        sql`${skills.id} != ${skillId}`,
      ))
      .limit(1);
    if (other && other.contentHash !== newHash && other.embedding.length === vector.length) {
      const identical = other.embedding.every((v: number, i: number) => Math.abs(v - vector[i]) < 1e-7);
      if (identical) {
        return { error: "embed_failed" as const };
      }
    }
    updates.embedding = vector;
    if (contentChanged) {
      updates.content = newContent;
      updates.contentHash = hashContent(newContent);
      updates.version = existing.version + 1;
    }
  }

  // Optimistic locking: only UPDATE if version hasn't changed since we read it.
  // This prevents lost updates without a transaction (works with existing mock tests).
  if (contentChanged) {
    updates.version = existing.version + 1;
  }
  const [row] = await db
    .update(skills)
    .set(updates)
    .where(
      and(
        eq(skills.id, skillId),
        eq(skills.userId, userId),
        eq(skills.version, existing.version),
      ),
    )
    .returning({
      id: skills.id,
      version: skills.version,
      content: skills.content,
      name: skills.name,
      contentHash: skills.contentHash,
    });

  if (!row) {
    // Either skill was deleted, or version changed (concurrent edit)
    // Check if the skill still exists to distinguish
    const [check] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.id, skillId), eq(skills.userId, userId)))
      .limit(1);
    if (check) return { error: "version_conflict" as const };
    return null;
  }

  return row;
}

/**
 * List all skills for a user, optionally filtered by status.
 * Excludes embedding; returns metadata only.
 * Ordered by updatedAt desc, limit 100.
 *
 * When includeDuplicates is true, each skill is annotated with a `duplicates`
 * array listing other active skills with similarity >= 0.88.
 * This lets the AI identify and clean up redundant skills in a single call,
 * conserving MAX_TOOL_ROUNDS (no separate find-duplicates round needed).
 */
export async function listSkills(
  userId: string,
  status?: "active" | "archived",
  includeDuplicates = false,
): Promise<
  | {
      id: string;
      name: string;
      content: string;
      kind: string;
      trigger: string | null;
      tags: string[];
      status: string;
      version: number;
      lastUsedAt: Date | null;
      successCount: number;
      failureCount: number;
      createdAt: Date;
      updatedAt: Date;
      duplicates?: { id: string; name: string; similarity: number }[];
    }[]
> {
  const whereClause = status
    ? and(eq(skills.userId, userId), eq(skills.status, status))
    : eq(skills.userId, userId);

  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      content: skills.content,
      kind: skills.kind,
      trigger: skills.trigger,
      tags: skills.tags,
      status: skills.status,
      version: skills.version,
      lastUsedAt: skills.lastUsedAt,
      successCount: skills.successCount,
      failureCount: skills.failureCount,
      createdAt: skills.createdAt,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(whereClause)
    .orderBy(desc(skills.updatedAt))
    .limit(100);

  if (!includeDuplicates || rows.length === 0) return rows;

  // Find all duplicate pairs via a single SQL self-join on stored embeddings.
  // a.id < b.id avoids duplicate pairs and self-matches.
  const pairs = await findAllDuplicatePairs(userId, 0.88);

  // Build a lookup: skillId -> list of duplicate peers.
  const dupMap = new Map<string, { id: string; name: string; similarity: number }[]>();
  for (const p of pairs) {
    if (!dupMap.has(p.aId)) dupMap.set(p.aId, []);
    if (!dupMap.has(p.bId)) dupMap.set(p.bId, []);
    dupMap.get(p.aId)!.push({ id: p.bId, name: p.bName, similarity: p.similarity });
    dupMap.get(p.bId)!.push({ id: p.aId, name: p.aName, similarity: p.similarity });
  }

  return rows.map((row) => ({
    ...row,
    duplicates: dupMap.get(row.id) ?? [],
  }));
}

/**
 * Create a new skill. Generates embedding + contentHash.
 * Returns { error: "duplicate" } if contentHash matches an existing skill.
 * Throws "name and content are required" if either is empty.
 * Throws "Embedding failed" if embedText returns [].
 */
export async function createSkill(
  userId: string,
  data: {
    name: string;
    content: string;
    kind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
    trigger?: string;
    tags?: string[];
  },
): Promise<
  | { id: string; name: string; content: string; kind: string; trigger: string | null; tags: string[]; status: string; version: number }
  | { error: "duplicate" }
> {
  const name = data.name.trim();
  const content = data.content.trim();
  if (!name || !content) {
    throw new Error("name and content are required");
  }
  const kind = data.kind ?? "workflow";
  const trigger = data.trigger?.trim() || "";
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((t): t is string => typeof t === "string")
    : [];

  const embedSource = [name, trigger, tags.join(", "), content].filter(Boolean).join("\n");
  const vector = await embedText(embedSource, "document");
  if (vector.length === 0) {
    throw new Error("Embedding failed");
  }
  const contentHash = hashContent(content);

  // Guard against degenerate embeddings: if the embedder returns the same
  // vector for different content (e.g., CLS-pooling constant), every skill
  // would appear identical. Compare the new vector against an existing
  // skill with a different contentHash — if embeddings match, the embedder
  // is broken.
  const [existing] = await db
    .select({ id: skills.id, embedding: skills.embedding, contentHash: skills.contentHash })
    .from(skills)
    .where(and(eq(skills.userId, userId), eq(skills.status, "active")))
    .limit(1);
  if (existing && existing.contentHash !== contentHash) {
    const existingVec = existing.embedding;
    if (existingVec.length === vector.length) {
      const identical = existingVec.every((v: number, i: number) => Math.abs(v - vector[i]) < 1e-7);
      if (identical) {
        throw new Error("Embedding service returned a degenerate vector (identical to existing skill)");
      }
    }
  }

  const [dup] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.userId, userId), eq(skills.contentHash, contentHash)))
    .limit(1);
  if (dup) return { error: "duplicate" as const };

  const [row] = await db
    .insert(skills)
    .values({
      userId,
      name,
      content,
      embedding: vector,
      contentHash,
      kind,
      trigger,
      tags,
    })
    .returning({
      id: skills.id,
      name: skills.name,
      content: skills.content,
      kind: skills.kind,
      trigger: skills.trigger,
      tags: skills.tags,
      status: skills.status,
      version: skills.version,
    });
  return row;
}

/**
 * Delete a skill (physical delete). Scoped by userId.
 * Returns true if deleted, false if not found.
 */
export async function deleteSkill(userId: string, id: string): Promise<boolean> {
  const [row] = await db
    .delete(skills)
    .where(and(eq(skills.id, id), eq(skills.userId, userId)))
    .returning({ id: skills.id });
  return !!row;
}

/**
 * Find all duplicate pairs among a user's active skills via a single SQL self-join.
 * Compares stored document embeddings pairwise (document-to-document, not query).
 * a.id < b.id avoids self-matches and duplicate pairs.
 * Returns [] if fewer than 2 skills exist.
 */
export async function findAllDuplicatePairs(
  userId: string,
  threshold = 0.88,
): Promise<{ aId: string; aName: string; bId: string; bName: string; similarity: number }[]> {
  const maxDistance = 1 - threshold;
  const rows = await db.all(sql`
    SELECT a.id AS a_id, a.name AS a_name,
           b.id AS b_id, b.name AS b_name,
           vec_distance_cosine(a.embedding, b.embedding) AS distance
    FROM skills a
    JOIN skills b ON a.user_id = b.user_id AND a.id < b.id
    WHERE a.user_id = ${userId}
      AND a.status = 'active'
      AND b.status = 'active'
      AND vec_distance_cosine(a.embedding, b.embedding) < ${maxDistance}
    ORDER BY distance
  `) as { a_id: string; a_name: string; b_id: string; b_name: string; distance: number }[];

  return rows.map((r) => ({
    aId: r.a_id,
    aName: r.a_name,
    bId: r.b_id,
    bName: r.b_name,
    similarity: Number(distanceToSimilarity(r.distance).toFixed(3)),
  }));
}
