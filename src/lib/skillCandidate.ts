import type OpenAI from "openai";
import { asc, eq, and } from "drizzle-orm";
import { db } from "@/db";
import { messages, skillCandidates, skills, threads } from "@/db/schema";
import { hashContent, embedText, embedTexts } from "@/lib/embed";
import { toVecBuffer, cosineSimilarity } from "@/lib/vectorSearch";
import { logger } from "@/lib/logger";
import { sql } from "drizzle-orm";

/**
 * Skill candidate extraction — automatically extracts reusable skill candidates from conversations.
 *
 * When the user explicitly says "save as skill", generateSkillFromConversation
 * creates the skill directly, but this module automatically extracts candidates
 * after every conversation and saves them as skills only after user approval
 * (approval-based learning loop).
 *
 * If the LLM does not recognize a concrete reusable skill, no candidate is created.
 * Max 3 candidates per conversation.
 */

const SYSTEM_PROMPT = `You are a skill candidate extractor. Analyze the conversation and identify concrete reusable skills worth saving for future use.

Only extract:
- Concrete reusable procedures (step-by-step workflows)
- Debugging patterns (how a specific bug was diagnosed and fixed)
- Project rules (conventions, gotchas, must-do rules)
- Tool usage patterns (how to use a specific tool/API correctly)
- Implementation patterns (reusable code patterns or architectural decisions)

Do NOT extract:
- User preferences, personal info, or identity
- General facts or broad advice
- Temporary context or one-off task details
- Generic programming knowledge found in any docs
- Persona or style instructions

If no concrete reusable skill exists in this conversation, return an empty array: []

Maximum 3 candidates per conversation. Each candidate must be genuinely reusable across future conversations.
Do NOT produce multiple candidates that cover the same topic from slightly different angles — merge overlapping candidates into a single, comprehensive one.

Respond in JSON only:
[{"name": "short skill name (2-5 words)", "kind": "workflow|bugfix|project_rule|tool_usage|coding_pattern|debugging", "trigger": "when to apply this skill (natural language)", "tags": ["tag1"], "content": "reusable instructions in second person (You should... / When X happens, do Y)", "confidence": 0.0-1.0, "reason": "why this skill is worth saving"}]`;

type ExtractedCandidate = {
  name: string;
  kind: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  trigger: string;
  tags: string[];
  content: string;
  confidence: number;
  reason: string;
};

/**
 * Parses ExtractedCandidate array from the LLM's raw response.
 * Removes markdown code fences and parses JSON.
 * Returns null on invalid input; the caller skips it.
 */
export function parseCandidates(raw: string | null | undefined): ExtractedCandidate[] | null {
  if (!raw || !raw.trim()) return null;
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (!Array.isArray(parsed)) return null;
    const validKinds = ["workflow", "bugfix", "project_rule", "tool_usage", "coding_pattern", "debugging"] as const;
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((obj) => {
        const name = obj.name;
        const content = obj.content;
        const kind = obj.kind;
        const trigger = obj.trigger;
        const tags = obj.tags;
        const confidence = obj.confidence;
        const reason = obj.reason;
        if (typeof name !== "string" || !name.trim()) return null;
        if (typeof content !== "string" || !content.trim()) return null;
        return {
          name: name.trim(),
          content: content.trim(),
          kind:
            typeof kind === "string" && (validKinds as readonly string[]).includes(kind)
              ? (kind as (typeof validKinds)[number])
              : "workflow",
          trigger: typeof trigger === "string" ? trigger.trim() : "",
          tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
          confidence: typeof confidence === "number" ? Math.max(0, Math.min(1, confidence)) : 0.5,
          reason: typeof reason === "string" ? reason.trim() : "",
        } satisfies ExtractedCandidate;
      })
      .filter((c): c is ExtractedCandidate => c !== null)
      .slice(0, 3);
  } catch {
    return null;
  }
}

/** Similarity threshold for intra-batch semantic dedup. */
const DEDUP_SIMILARITY_THRESHOLD = 0.88;

/**
 * Removes semantically duplicate candidates within the same extraction batch.
 *
 * Batch-embeds all candidate contents, then pairwise-compares via cosine
 * similarity. When two candidates exceed the threshold, the lower-confidence
 * one (or the shorter one if confidence is equal) is dropped.
 *
 * Max 3 candidates → at most 3 comparisons. Negligible cost.
 */
async function dedupWithinBatch(
  candidates: ExtractedCandidate[],
): Promise<ExtractedCandidate[]> {
  if (candidates.length <= 1) return candidates;

  const texts = candidates.map(
    (c) => [c.name, c.trigger, c.tags.join(", "), c.content].filter(Boolean).join("\n"),
  );
  const vectors = await embedTexts(texts, "document");
  // If any vector is empty (embed failure), skip dedup to be safe.
  if (vectors.some((v) => v.length === 0)) return candidates;

  const dropped = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < candidates.length; j++) {
      if (dropped.has(j)) continue;
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim < DEDUP_SIMILARITY_THRESHOLD) continue;
      // Pick the survivor: higher confidence, tie-break by longer content.
      const ci = candidates[i];
      const cj = candidates[j];
      const keepI =
        ci.confidence !== cj.confidence
          ? ci.confidence > cj.confidence
          : ci.content.length >= cj.content.length;
      dropped.add(keepI ? j : i);
      if (!keepI) break;
      logger.info("skill-candidate", "intra-batch dedup", {
        kept: keepI ? ci.name : cj.name,
        dropped: keepI ? cj.name : ci.name,
        similarity: Number(sim.toFixed(3)),
      });
    }
  }
  return candidates.filter((_, idx) => !dropped.has(idx));
}

/** Result of checking a candidate against existing drafts/skills. */
type DedupResult = {
  /** The candidate to insert (null = skip insertion entirely). */
  candidate: ExtractedCandidate | null;
  contentHash: string;
  /** When candidate is non-null, flags which existing record it duplicates. */
  duplicateOfId: string | null;
  duplicateOfType: "skill" | "candidate" | null;
};

/**
 * Checks a single candidate against existing drafts and active skills.
 *
 * Tier 1: contentHash against existing drafts (cheap, no embedding).
 * Tier 2: contentHash against active skills (cheap, no embedding).
 * Tier 3: embedding cosine similarity against active skills (expensive,
 *   only when contentHash doesn't match). If similarity > threshold,
 *   mark as duplicate of that skill.
 *
 * Never modifies existing skills or candidates — only flags the new one.
 */
async function checkDuplicate(
  candidate: ExtractedCandidate,
  userId: string,
): Promise<DedupResult> {
  const contentHash = hashContent(candidate.content);

  // Tier 1: existing draft with same contentHash
  const [existingDraft] = await db
    .select({ id: skillCandidates.id })
    .from(skillCandidates)
    .where(
      and(
        eq(skillCandidates.userId, userId),
        eq(skillCandidates.contentHash, contentHash),
        eq(skillCandidates.status, "draft"),
      ),
    )
  if (existingDraft) {
    // Byte-identical to an existing draft — skip entirely.
    return { candidate: null, contentHash, duplicateOfId: existingDraft.id, duplicateOfType: "candidate" };
  }

  // Tier 2: existing active skill with same contentHash
  const [existingSkill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.userId, userId), eq(skills.contentHash, contentHash)))
    .limit(1);
  if (existingSkill) {
    // Byte-identical to an existing active skill — skip entirely.
    return { candidate: null, contentHash, duplicateOfId: existingSkill.id, duplicateOfType: "skill" };
  }
  // Tier 3: semantic similarity against existing draft candidates.
  // Catches near-duplicates where the LLM rephrased the content slightly
  // but contentHash (Tier 1) didn't match. Skips insertion if a draft with
  // similarity >= 0.88 already exists.
  const embedSource = [candidate.name, candidate.trigger, candidate.tags.join(", "), candidate.content]
    .filter(Boolean)
    .join("\n");
  const queryVector = await embedText(embedSource, "document");
  if (queryVector.length > 0) {
    const queryBuf = toVecBuffer(queryVector);

    // Check against existing draft candidates (no embedding column — use
    // embedTexts to batch-embed all draft contents, then compare in JS).
    const drafts = await db
      .select({ id: skillCandidates.id, proposedContent: skillCandidates.proposedContent,
                proposedName: skillCandidates.proposedName, proposedTrigger: skillCandidates.proposedTrigger,
                proposedTags: skillCandidates.proposedTags })
      .from(skillCandidates)
      .where(and(eq(skillCandidates.userId, userId), eq(skillCandidates.status, "draft")))
      .limit(100);

    if (drafts.length > 0) {
      const draftTexts = drafts.map((d) =>
        [d.proposedName, d.proposedTrigger, (d.proposedTags ?? []).join(", "), d.proposedContent]
          .filter(Boolean).join("\n"),
      );
      const draftVectors = await embedTexts(draftTexts, "document");
      for (let i = 0; i < drafts.length; i++) {
        if (draftVectors[i].length === 0) continue;
        const sim = cosineSimilarity(queryVector, draftVectors[i]);
        if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
          logger.info("skill-candidate", "skipped semantically duplicate draft", {
            name: candidate.name,
            existingDraft: drafts[i].proposedName,
            similarity: Number(sim.toFixed(3)),
          });
          return { candidate: null, contentHash, duplicateOfId: drafts[i].id, duplicateOfType: "candidate" };
        }
      }
    }

    // Tier 4: semantic similarity against active skills.
    // Skip insertion (not flag-and-insert) if a highly similar skill exists.
    // The previous flag-and-insert behavior caused duplicate draft accumulation
    // and orphaned-reference bugs when the referenced skill was deleted.
    const rows = await db.all(sql`
      SELECT id
      FROM skills
      WHERE user_id = ${userId}
        AND status = 'active'
        AND vec_distance_cosine(embedding, ${queryBuf}) < ${1 - DEDUP_SIMILARITY_THRESHOLD}
      LIMIT 1
    `) as { id: string }[];
    if (rows.length > 0) {
      logger.info("skill-candidate", "skipped semantically duplicate skill", {
        name: candidate.name,
        existingSkillId: rows[0].id,
      });
      return { candidate: null, contentHash, duplicateOfId: rows[0].id, duplicateOfType: "skill" };
    }
  }

  return { candidate, contentHash, duplicateOfId: null, duplicateOfType: null };
}

/**
 * Extracts skill candidates from a thread's conversation and saves them as drafts.
 *
 * 1. Verify userId from threads
 * 2. Get messages in chronological order
 * 3. Extract candidates via LLM (do nothing if [])
 * 4. Insert each candidate into the skill_candidates table as a draft
 *
 * Skips on LLM failure, empty array, or parse failure (does not throw).
 */
export async function extractSkillCandidates(
  threadId: string,
  userId: string,
  llm: OpenAI,
  model: string,
): Promise<void> {
  // Verify thread owner
  const [thread] = await db
    .select({ userId: threads.userId })
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!thread || thread.userId !== userId) return;

  // Get all messages in chronological order
  const allMessages = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  const hasUser = allMessages.some((m) => m.role === "user");
  const hasAssistant = allMessages.some((m) => m.role === "assistant");
  if (!hasUser || !hasAssistant || allMessages.length === 0) return;

  // Extract candidates via LLM
  let candidates: ExtractedCandidate[] | null;
  try {
    const completion = await llm.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: allMessages
            .map((m) => `${m.role}: ${m.content}`)
            .join("\n"),
        },
      ],
    });
    candidates = parseCandidates(completion.choices[0]?.message?.content);
  } catch (err) {
    logger.error("skill-candidate", "LLM extraction failed", { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (!candidates || candidates.length === 0) return;

  // Step 1: Intra-batch semantic dedup (contentHash can't catch near-duplicates)
  candidates = await dedupWithinBatch(candidates);
  if (candidates.length === 0) return;

  // Step 2: Check each candidate against existing drafts/skills, then insert
  let insertedCount = 0;
  for (const c of candidates) {
    try {
      const result = await checkDuplicate(c, userId);
      // Byte-identical to existing draft/skill → skip insertion entirely.
      if (result.candidate === null) {
        logger.info("skill-candidate", "skipped byte-identical duplicate", {
          name: c.name,
          duplicateOfId: result.duplicateOfId,
          duplicateOfType: result.duplicateOfType,
        });
        continue;
      }
      await db.insert(skillCandidates).values({
        userId,
        threadId,
        proposedName: c.name,
        proposedKind: c.kind,
        proposedTrigger: c.trigger,
        proposedContent: c.content,
        proposedTags: c.tags,
        confidence: c.confidence,
        reason: c.reason,
        contentHash: result.contentHash,
        duplicateOfId: result.duplicateOfId,
        duplicateOfType: result.duplicateOfType,
        status: "draft",
      });
      insertedCount++;
    } catch (err) {
      logger.error("skill-candidate", "failed to insert candidate", { name: c.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info("skill-candidate", "extracted candidates", { count: insertedCount, threadId });
}
