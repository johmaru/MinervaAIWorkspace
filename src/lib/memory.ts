import type OpenAI from "openai";
import { and, asc, eq, inArray, desc, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { memories, threads, folders } from "@/db/schema";
import { embedText, hashContent } from "@/lib/embed";
import { activeMemoryConditions } from "@/lib/memoryUtils";
import { cosineSimilarity } from "@/lib/vectorSearch";
import { logger } from "@/lib/logger";

/**
 * Memory system — summarizes and classifies conversations after assistant responses, then stores them.
 *
 * Flow:
 * 1. generateMemories: passes recent turns to the LLM, classifies as fact/working + determines new/replace/merge.
 * 2. findRelevantMemories (memoryStore.ts): on next send, searches via cosine similarity → similarity + recency top-5.
 * 3. chat route injects into system context.
 *
 * On replace/merge/contradiction, old memories are invalidated via validUntil (kept as history, excluded from active search). suppressedAt is only used for user-initiated DELETE.
 */

export type MemoryKind = "fact" | "working";

export type ExtractedMemory = {
  kind: MemoryKind;
  content: string;
  importance?: number;
  action: "new" | "replace" | "merge";
  /** On replace/merge: the existing memory's content (for similarity-based lookup) */
  targetContent?: string;
  /** On replace/merge: the existing memory's ID (for direct specification. targetId takes precedence) */
  targetId?: string;
};

const SYSTEM_PROMPT = `You are a memory extractor. Analyze the conversation and extract durable memories.

Classify each memory as:
- "fact": user info, environment, preferences, identity, goals, topics discussed, subjects explored, decisions made
- "working": current task, temporary context, recent decisions, ongoing discussion topic

For each memory, decide an action:
- "new": no similar existing memory exists
- "replace": supersedes an existing memory that is now outdated or wrong
- "merge": combines with an existing memory to form a richer one

When action is "replace" or "merge", set targetId to the ID of the existing memory you are replacing or merging with. The existing memories are listed with their IDs below. If you cannot identify the exact memory by ID, set targetContent to the EXACT content string instead.

Write each memory's content as a concise, search-friendly sentence. Capture the topic and key facts, not just the user's identity.

Skip pure greetings and acknowledgments (e.g. 'hello', 'thanks', 'got it'), BUT always save what was discussed or decided. If the conversation only contains greetings with no substance, return an empty array. Otherwise, extract at least one memory about what was discussed.

Return ONLY valid JSON (no markdown fences):
[{"kind": "fact"|"working", "content": "...", "importance": 0.0-1.0, "action": "new"|"replace"|"merge", "targetId": "... (existing memory ID, for replace/merge)", "targetContent": "... (fallback: exact content string, for replace/merge)"}]`;

/**
 * Builds the messages to send to the LLM in generateMemories.
 * Presents recent turns + the list of existing active memories.
 */
function buildExtractionMessages(
  recentTurns: { role: string; content: string }[],
  existingMemories: { id: string; content: string }[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const conversation = recentTurns
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");

  const existingList =
    existingMemories.length > 0
      ? existingMemories
          .map((m) => `ID: ${m.id} | ${m.content}`)
          .join("\n")
      : "(none)";

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Recent conversation:\n${conversation}\n\nExisting active memories:\n${existingList}\n\nExtract memories as JSON array.`,
    },
  ];
}

/**
 * Parses ExtractedMemory array from the LLM's raw response.
 * Returns null on invalid input; the caller skips it.
 */
function parseExtraction(raw: string | null | undefined): ExtractedMemory[] | null {
  if (!raw || !raw.trim()) return null;
  // Remove markdown code fences
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((m): m is ExtractedMemory => {
        if (typeof m !== "object" || m === null) return false;
        const kind = (m as ExtractedMemory).kind;
        const action = (m as ExtractedMemory).action;
        const content = (m as ExtractedMemory).content;
        if (kind !== "fact" && kind !== "working") return false;
        if (action !== "new" && action !== "replace" && action !== "merge") return false;
        if (typeof content !== "string" || !content.trim()) return false;
        return true;
      })
      .map((m) => ({
        kind: m.kind,
        content: m.content.trim(),
        importance: typeof m.importance === "number" ? m.importance : 0.5,
        action: m.action,
        targetContent: m.targetContent,
        targetId: typeof m.targetId === "string" ? m.targetId : undefined,
      }));
  } catch {
    return null;
  }
}

/**
 * Searches for an existing active memory by targetId or targetContent.
 * If targetId is present, searches directly by ID (any scope).
 * Otherwise, searches by exact content match (within threadId scope).
 * Returns null if not found.
 */
async function findExistingMemory(
  threadId: string,
  targetContent: string | undefined,
  targetId?: string,
): Promise<{ id: string } | null> {
  if (targetId) {
    const [row] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(and(eq(memories.id, targetId), ...activeMemoryConditions()))
      .limit(1);
    if (row) return row;
  }
  if (!targetContent) return null;
  const [row] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.threadId, threadId),
        eq(memories.content, targetContent),
        ...activeMemoryConditions(),
      ),
    )
    .orderBy(asc(memories.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Re-integrates an existing memory's content via the LLM.
 * mergeContents returns the merged text in a single LLM call.
 */
async function mergeContents(
  existing: string,
  incoming: string,
  llm: OpenAI,
  model: string,
): Promise<string> {
  const completion = await llm.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "Merge two memories into one concise, search-friendly sentence. Preserve all key facts. Return only the merged sentence, no explanation.",
      },
      {
        role: "user",
        content: `Existing: ${existing}\nNew: ${incoming}\nMerged:`,
      },
    ],
  });
  const merged = completion.choices[0]?.message?.content?.trim();
  return merged || incoming;
}

/**
 * Checks whether a new memory contradicts an existing memory via a single LLM call.
 * Returns true if the two memories contradict each other (same subject, conflicting info).
 * Returns false if they are complementary or unrelated.
 */
async function checkContradiction(
  existingContent: string,
  newContent: string,
  llm: OpenAI,
  model: string,
): Promise<boolean> {
  try {
    const completion = await llm.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a contradiction detector. Determine whether the two statements contradict each other (same subject but conflicting information). Reply ONLY with 'yes' or 'no'.",
        },
        {
          role: "user",
          content: `Statement A: ${existingContent}\nStatement B: ${newContent}\nDo these contradict each other?`,
        },
      ],
    });
    const answer = completion.choices[0]?.message?.content?.trim().toLowerCase();
    return answer === "yes";
  } catch {
    // On LLM failure, don't block insertion — assume no contradiction
    return false;
  }
}

/**
 * Checks whether a working memory should be promoted to fact via a single LLM call.
 * Returns true if the working memory represents a confirmed, stable fact.
 */
async function checkPromotion(
  memoryContent: string,
  injectionCount: number,
  llm: OpenAI,
  model: string,
): Promise<boolean> {
  try {
    const completion = await llm.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a memory classifier. Determine whether a 'working' memory (temporary context) has become a confirmed, stable fact that is unlikely to change. Consider: is this a permanent attribute, a completed decision, or a stable preference? Reply ONLY with 'yes' or 'no'.",
        },
        {
          role: "user",
          content: `Memory (working): ${memoryContent}\nThis memory has been referenced by the user ${injectionCount} times.\nHas this become a confirmed fact?`,
        },
      ],
    });
    const answer = completion.choices[0]?.message?.content?.trim().toLowerCase();
    return answer === "yes";
  } catch {
    // On LLM failure, don't promote — leave as working
    return false;
  }
}

/**
 * Extracts memories from recent turns and stores them in the memories table.
 *
 * - LLM does not return JSON → skip (logger.error only)
 * - Existing memory not found by targetContent → fall back to new
 * - Embed returns empty array (e.g. model loading) → skip memory storage
 * - replace/merge with multiple hits → target the oldest one
 *
 * @param threadId Target thread
 * @param recentTurns Recent conversation (user + assistant pairs)
 * @param llm LLM client (injectable for tests)
 * @param model LLM model id
 * @param userId Owner user ID (overrides thread's userId)
 * @param sourceMessageIds IDs of the messages this extraction is based on (stored for traceability)
 */
export async function generateMemories(
  threadId: string,
  recentTurns: { role: string; content: string }[],
  llm: OpenAI,
  model: string,
  userId?: string,
  sourceMessageIds?: string[],
): Promise<void> {
  // Early return if no user/assistant pair
  const hasUser = recentTurns.some((t) => t.role === "user");
  const hasAssistant = recentTurns.some((t) => t.role === "assistant");
  if (!hasUser || !hasAssistant || recentTurns.length === 0) return;

  // Get folderId and userId from threads
  const [thread] = await db
    .select({ folderId: threads.folderId, userId: threads.userId })
    .from(threads)
    .where(eq(threads.id, threadId));
  const folderId = thread?.folderId ?? null;
  const effectiveUserId = userId ?? thread?.userId;

  // ── Resolve memory scope (shared by promotion + existing fetch) ──
  // folder memoryScope="folder" → same folderId only
  // folder memoryScope="global" (or no folder) → all threads owned by the user
  let scopeCondition: SQL;
  if (folderId) {
    const [folder] = await db
      .select({ memoryScope: folders.memoryScope })
      .from(folders)
      .where(eq(folders.id, folderId));
    if (folder?.memoryScope === "folder") {
      scopeCondition = eq(memories.folderId, folderId);
    } else {
      const threadIds = effectiveUserId
        ? (await db
            .select({ id: threads.id })
            .from(threads)
            .where(eq(threads.userId, effectiveUserId)))
            .map((t) => t.id)
        : [threadId];
      scopeCondition = inArray(memories.threadId, threadIds);
    }
  } else {
    scopeCondition = eq(memories.threadId, threadId);
  }

  // ── Working → Fact promotion ──
  // Find working memories with injectionCount >= 3 AND injectionCount % 3 === 0 (throttle:
  // re-check only every 3 injections to avoid repeated LLM calls on every turn).
  // Also require lastReferencedAt within the last 7 days (still actively used).
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const promotionCandidates = await db
    .select({
      id: memories.id,
      content: memories.content,
      injectionCount: memories.injectionCount,
    })
    .from(memories)
    .where(
      and(
        scopeCondition,
        eq(memories.kind, "working"),
        ...activeMemoryConditions(),
        sql`${memories.injectionCount} >= 3`,
        sql`${memories.injectionCount} % 3 = 0`,
        sql`${memories.lastReferencedAt} > ${sevenDaysAgo.getTime()}`,
      ),
    )
    .limit(5);

  for (const candidate of promotionCandidates) {
    try {
      const shouldPromote = await checkPromotion(
        candidate.content,
        candidate.injectionCount,
        llm,
        model,
      );
      if (shouldPromote) {
        await db
          .update(memories)
          .set({ kind: "fact", expiresAt: null, updatedAt: new Date() })
          .where(eq(memories.id, candidate.id));
        logger.info("memory", "promoted working memory to fact", {
          memoryId: candidate.id,
          content: candidate.content,
          injectionCount: candidate.injectionCount,
        });
      }
    } catch (err) {
      logger.error("memory", "promotion check failed", {
        memoryId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // ── End promotion ──

  // Get existing active memories (to present to the LLM), using the same scope
  const existing = await db
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(scopeCondition, ...activeMemoryConditions()))
    .orderBy(desc(memories.updatedAt))
    .limit(20);

  // Extract memories via LLM
  let extracted: ExtractedMemory[] | null;
  try {
    const completion = await llm.chat.completions.create({
      model,
      messages: buildExtractionMessages(recentTurns, existing),
    });
    extracted = parseExtraction(completion.choices[0]?.message?.content);
  } catch (err) {
    logger.error("memory", "LLM extraction failed", { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  if (!extracted || extracted.length === 0) return;

  const embedModel = process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
  const now = new Date();

  for (const mem of extracted) {
    try {
      if (mem.action === "replace" && (mem.targetId || mem.targetContent)) {
        const target = await findExistingMemory(threadId, mem.targetContent, mem.targetId);
        if (target) {
          // Set validUntil (not suppressedAt) — the old memory is invalidated, not user-deleted.
          // It remains as history but is excluded from active search.
          await db
            .update(memories)
            .set({ validUntil: now, updatedAt: now })
            .where(eq(memories.id, target.id));
        }
        // Even if target not found, save as a new memory (fallback)
      } else if (mem.action === "merge" && (mem.targetId || mem.targetContent)) {
        const target = await findExistingMemory(threadId, mem.targetContent, mem.targetId);
        if (target) {
          const existingContent =
            existing.find((m) => m.id === target.id)?.content ?? mem.targetContent ?? "";
          const mergedContent = await mergeContents(existingContent, mem.content, llm, model);
          const vector = await embedText(mergedContent, "document");
          if (vector.length === 0) continue; // embed failed → skip
          await db
            .update(memories)
            .set({
              content: mergedContent,
              embedding: vector,
              contentHash: hashContent(mergedContent),
              importance: mem.importance ?? 0.5,
              updatedAt: now,
            })
            .where(eq(memories.id, target.id));
          continue; // merge complete, no new INSERT
        }
        // Target not found → fall back to new
      }

      // action === "new" or fallback
      const vector = await embedText(mem.content, "document");
      if (vector.length === 0) continue; // embed failed → skip

      const contentHash = hashContent(mem.content);
      // Avoid duplicates via contentHash (skip if exists among active memories)
      const [dup] = await db
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.threadId, threadId),
            eq(memories.contentHash, contentHash),
            ...activeMemoryConditions(),
          ),
        )
        .limit(1);
      if (dup) continue;

      // ── Contradiction detection ──
      // Query active memories with embeddings in the same scope, compute cosine
      // against the new memory's vector, and check candidates with sim > 0.75 via LLM.
      // If a contradiction is found, the old memory is invalidated (validUntil = now).
      const contradictCandidates = await db
        .select({
          id: memories.id,
          content: memories.content,
          embedding: memories.embedding,
        })
        .from(memories)
        .where(and(scopeCondition, ...activeMemoryConditions()))
        .limit(50);

      for (const candidate of contradictCandidates) {
        const sim = cosineSimilarity(vector, candidate.embedding);
        if (sim <= 0.75) continue;
        const isContradiction = await checkContradiction(
          candidate.content,
          mem.content,
          llm,
          model,
        );
        if (isContradiction) {
          // Invalidate the old memory — keep as history, exclude from active search
          await db
            .update(memories)
            .set({ validUntil: now, updatedAt: now })
            .where(eq(memories.id, candidate.id));
          logger.info("memory", "contradiction detected, invalidating old memory", {
            oldMemoryId: candidate.id,
            oldContent: candidate.content,
            newContent: mem.content,
            similarity: Number(sim.toFixed(3)),
          });
        }
      }

      // working memories auto-expire after 7 days; fact memories never auto-expire
      const expiresAt = mem.kind === "working"
        ? new Date(now.getTime() + 7 * 86_400_000)
        : null;

      await db.insert(memories).values({
        threadId,
        folderId,
        kind: mem.kind,
        content: mem.content,
        sourceMessageIds: sourceMessageIds ?? null,
        embedding: vector,
        contentHash,
        model: embedModel,
        importance: mem.importance ?? 0.5,
        validFrom: now,
        expiresAt,
      });
    } catch (err) {
      logger.error("memory", "failed to save memory", { content: mem.content, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

