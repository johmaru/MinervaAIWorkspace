import type OpenAI from "openai";
import { and, asc, eq, isNull, inArray, desc } from "drizzle-orm";
import { db } from "@/db";
import { memories, threads, folders } from "@/db/schema";
import { embedText, hashContent } from "@/lib/embed";
import { logger } from "@/lib/logger";

/**
 * Memory system — summarizes and classifies conversations after assistant responses, then stores them.
 *
 * Flow:
 * 1. generateMemories: passes recent turns to the LLM, classifies as fact/working + determines new/replace/merge.
 * 2. findRelevantMemories (memoryStore.ts): on next send, searches via cosine similarity → similarity + recency top-5.
 * 3. chat route injects into system context.
 *
 * On replace/merge, old memories are soft-deleted via suppressedAt (not physically deleted).
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
      .where(and(eq(memories.id, targetId), isNull(memories.suppressedAt)))
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
        isNull(memories.suppressedAt),
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
 */
export async function generateMemories(
  threadId: string,
  recentTurns: { role: string; content: string }[],
  llm: OpenAI,
  model: string,
  userId?: string,
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

  // Get existing active memories (to present to the LLM)
  // Scope: same folder or cross-thread, depending on folder.memoryScope
  let existing: { id: string; content: string }[];
  if (folderId) {
    // Get the folder's memoryScope
    const [folder] = await db
      .select({ memoryScope: folders.memoryScope })
      .from(folders)
      .where(eq(folders.id, folderId));
    if (folder?.memoryScope === "folder") {
      // Get memories within the same folder
      existing = await db
        .select({ id: memories.id, content: memories.content })
        .from(memories)
        .where(and(eq(memories.folderId, folderId), isNull(memories.suppressedAt)))
        .orderBy(desc(memories.updatedAt))
        .limit(20);
    } else {
      // global: cross-thread for the same user
      const threadIds = effectiveUserId
        ? (await db
            .select({ id: threads.id })
            .from(threads)
            .where(eq(threads.userId, effectiveUserId)))
            .map((t) => t.id)
        : [threadId];
      existing = await db
        .select({ id: memories.id, content: memories.content })
        .from(memories)
        .where(
          and(
            inArray(memories.threadId, threadIds),
            isNull(memories.suppressedAt),
          ),
        )
        .orderBy(desc(memories.updatedAt))
        .limit(20);
    }
  } else {
    // No folder: same thread only (conventional behavior)
    existing = await db
      .select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(and(eq(memories.threadId, threadId), isNull(memories.suppressedAt)))
      .orderBy(asc(memories.createdAt));
  }

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

  for (const mem of extracted) {
    try {
      if (mem.action === "replace" && (mem.targetId || mem.targetContent)) {
        const target = await findExistingMemory(threadId, mem.targetContent, mem.targetId);
        if (target) {
          await db
            .update(memories)
            .set({ suppressedAt: new Date(), updatedAt: new Date() })
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
              updatedAt: new Date(),
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
      // Avoid duplicates via contentHash (skip if exists)
      const [dup] = await db
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.threadId, threadId),
            eq(memories.contentHash, contentHash),
            isNull(memories.suppressedAt),
          ),
        )
        .limit(1);
      if (dup) continue;

      await db.insert(memories).values({
        threadId,
        folderId,
        kind: mem.kind,
        content: mem.content,
        embedding: vector,
        contentHash,
        model: embedModel,
        importance: mem.importance ?? 0.5,
      });
    } catch (err) {
      logger.error("memory", "failed to save memory", { content: mem.content, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

