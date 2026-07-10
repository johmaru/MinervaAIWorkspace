import { eq, ne, and, desc, sql, inArray } from "drizzle-orm";
import { db } from "@/db";
import { memories, memoryInjections, folders, threads, messages } from "@/db/schema";
import { embedText } from "@/lib/embed";
import { cosineSimilarity } from "@/lib/vectorSearch";
import { activeMemoryConditions } from "@/lib/memoryUtils";
import type { MemoryKind } from "@/lib/memory";
import { findProfileTraits } from "@/lib/traitStore";

/**
 * Memory search — on next send, searches for relevant memories via client-side
 * cosine similarity and returns top-5 by similarity + recency + reference feedback.
 *
 * Scope:
 * - If folderId's folder has memoryScope="folder" → search only within the same folderId
 * - Otherwise (global or no folderId) → search across all threads
 */

export type ScoredMemory = {
  id: string;
  threadId: string;
  kind: MemoryKind;
  content: string;
  similarity: number;
  recencyScore: number;
  updatedAt: Date;
};

/**
 * Formats a relative time string for AI context (English).
 * Examples: "just now", "2 hours ago", "3 days ago", "2 weeks ago".
 * Used in memory injection so the AI can correlate user utterances like
 * "we talked about this a few days ago" with actual memory timestamps.
 *
 * @param date The timestamp to format
 * @param now Current time (default: new Date()) — injectable for testing
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  if (sec < 60) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  if (day === 1) return "1 day ago";
  if (day < 7) return `${day} days ago`;
  const week = Math.floor(day / 7);
  if (week === 1) return "1 week ago";
  if (day < 30) return `${week} weeks ago`;
  const month = Math.floor(day / 30);
  if (month === 1) return "1 month ago";
  return `${month} months ago`;
}

/**
 * Searches for relevant memories by query string and scope.
 *
 * 1. Vectorize the query via embedText(query, "query")
 * 2. Get candidate rows filtered by activeMemoryConditions() + userId + scope
 * 3. Compute cosine similarity client-side
 * 4. Filter by similarity > 0.3
 * 5. Score: importance × 0.4 + recency × 0.3 + refRecency × 0.3
 * 6. Return top-5 by score descending
 *
 * @param query User input
 * @param folderId The current thread's folderId (nullable)
 * @param userId ID of the user who owns the memories (prevents cross-user leakage)
 */
export async function findRelevantMemories(
  query: string,
  folderId: string | null,
  userId: string,
): Promise<ScoredMemory[]> {
  const queryVector = await embedText(query, "query");
  if (queryVector.length === 0) return [];

  // Scope check: if folderId's folder has memoryScope="folder", search only that folder
  let scopeFolder = false;
  let targetFolderId: string | null = null;
  if (folderId) {
    const [folder] = await db
      .select({ memoryScope: folders.memoryScope })
      .from(folders)
      .where(eq(folders.id, folderId));
    if (folder?.memoryScope === "folder") {
      scopeFolder = true;
      targetFolderId = folderId;
    }
  }

  // Get candidate rows using activeMemoryConditions (suppressed + validUntil + expiresAt)
  const conditions = [...activeMemoryConditions(), eq(threads.userId, userId)];
  if (scopeFolder && targetFolderId) {
    conditions.push(eq(memories.folderId, targetFolderId));
  }

  const rows = await db
    .select({
      id: memories.id,
      threadId: memories.threadId,
      kind: memories.kind,
      content: memories.content,
      embedding: memories.embedding,
      importance: memories.importance,
      lastReferencedAt: memories.lastReferencedAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .innerJoin(threads, eq(memories.threadId, threads.id))
    .where(and(...conditions));

  if (rows.length === 0) return [];

  // Client-side cosine similarity computation + feedback-weighted score
  const now = Date.now();
  const scored = rows
    .map((r) => {
      const sim = cosineSimilarity(queryVector, r.embedding);
      // recency: EXP(-ageDays / 14) — decays to e^-1 ≈ 0.37 after 14 days
      const ageDays = (now - new Date(r.updatedAt).getTime()) / 86_400_000;
      const recency = Math.exp(-ageDays / 14);
      // refRecency: EXP(-refAgeDays / 7) — how recently the memory was referenced by the user.
      // Memories never referenced get refRecency = 0 (no boost). Recently referenced memories get up to 1.0.
      const refAgeDays = r.lastReferencedAt
        ? (now - new Date(r.lastReferencedAt).getTime()) / 86_400_000
        : Infinity;
      const refRecency = r.lastReferencedAt ? Math.exp(-refAgeDays / 7) : 0;
      // Feedback-weighted score: importance 40% + recency 30% + refRecency 30%
      const recencyScore = r.importance * 0.4 + recency * 0.3 + refRecency * 0.3;
      return {
        id: r.id,
        threadId: r.threadId,
        kind: r.kind as MemoryKind,
        content: r.content,
        similarity: sim,
        recencyScore,
        updatedAt: r.updatedAt,
      };
    })
    .filter((r) => r.similarity > 0.3);

  if (scored.length === 0) return [];

  // top-30 by similarity descending → top-5 by recencyScore descending
  return scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 30)
    .sort((a, b) => b.recencyScore - a.recencyScore)
    .slice(0, 5)
    .map((r) => ({
      ...r,
      similarity: Number(r.similarity.toFixed(3)),
      recencyScore: Number(r.recencyScore.toFixed(3)),
    }));
}

/**
 * Fetches the user's recent thread titles (excluding the current thread and empty titles).
 * Passed to the AI along with memory context to help it infer past conversation topics.
 *
 * @param userId Current user ID
 * @param currentThreadId Current thread ID (excluded from results)
 * @param limit Fetch limit (default 15)
 */
export async function fetchRecentThreadTitles(
  userId: string,
  currentThreadId: string,
  limit = 15,
): Promise<string[]> {
  const rows = await db
    .select({ title: threads.title })
    .from(threads)
    .where(and(
      eq(threads.userId, userId),
      ne(threads.id, currentThreadId),
      ne(threads.title, "New chat"),
    ))
    .orderBy(desc(threads.updatedAt))
    .limit(limit);
  return rows.map((r) => r.title);
}

/**
 * Processes the feedback loop for previously injected memories.
 *
 * When a new message is sent, we look up which memories were injected for the
 * PREVIOUS user message in this thread. We then compute cosine similarity
 * between those memories' content and the new user input:
 *   - sim > 0.5 → the user continued the topic → boost importance +0.05 (cap 1.0),
 *     set lastReferencedAt = now
 *   - sim <= 0.5 → the user moved on → decay importance -0.02 (floor 0.1)
 *
 * This makes the memory system self-tuning: frequently-referenced memories
 * rise in importance, ignored ones sink.
 *
 * @param threadId Current thread
 * @param userMessageId The new user message ID (to find the previous message's injections)
 * @param newQuery The new user message content (to compare against injected memories)
 */
async function processFeedbackLoop(
  threadId: string,
  userMessageId: string,
  newQuery: string,
): Promise<void> {
  // Find the previous user message in this thread (not the parentId which is an assistant message).
  // In the chain user1 → assistant1 → user2, injections are recorded on user1.
  // parentId of user2 is assistant1, so we need to find the user message before this one.
  const [prevUserMsg] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(
      eq(messages.threadId, threadId),
      eq(messages.role, "user"),
      ne(messages.id, userMessageId),
    ))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  if (!prevUserMsg) return;

  // Find memories injected for the previous user message
  const injected = await db
    .select({
      memoryId: memoryInjections.memoryId,
      content: memories.content,
      embedding: memories.embedding,
      importance: memories.importance,
    })
    .from(memoryInjections)
    .innerJoin(memories, eq(memoryInjections.memoryId, memories.id))
    .where(eq(memoryInjections.messageId, prevUserMsg.id));

  if (injected.length === 0) return;

  const queryVector = await embedText(newQuery, "query");
  if (queryVector.length === 0) return;

  const now = new Date();
  for (const mem of injected) {
    const sim = cosineSimilarity(queryVector, mem.embedding);
    if (sim > 0.5) {
      // User continued the topic → boost
      const newImportance = Math.min(1.0, mem.importance + 0.05);
      await db
        .update(memories)
        .set({ importance: newImportance, lastReferencedAt: now, updatedAt: now })
        .where(eq(memories.id, mem.memoryId));
    } else {
      // User moved on → decay
      const newImportance = Math.max(0.1, mem.importance - 0.02);
      await db
        .update(memories)
        .set({ importance: newImportance, updatedAt: now })
        .where(eq(memories.id, mem.memoryId));
    }
  }
}

/**
 * Records which memories were injected for a given user message.
 * Called after findRelevantMemories returns results — persists the injection
 * set so the next turn's feedback loop can evaluate them.
 *
 * @param userMessageId The user message that triggered the injection
 * @param memoryIds The memory IDs that were injected into context
 */
async function recordInjections(
  userMessageId: string,
  memoryIds: string[],
): Promise<void> {
  if (memoryIds.length === 0) return;
  const now = new Date();
  const rows = memoryIds.map((memoryId) => ({
    messageId: userMessageId,
    memoryId,
    injectedAt: now,
  }));
  await db.insert(memoryInjections).values(rows);

  // Update injection tracking on all injected memories in one query
  await db
    .update(memories)
    .set({ injectionCount: sql`${memories.injectionCount} + 1`, lastInjectedAt: now })
    .where(inArray(memories.id, memoryIds));
}

/**
 * Resolves the memory search scope from the thread's folderId and builds relevant
 * memories as a system message. Also injects recent thread titles so the AI can
 * infer past conversation topics. Returns null if there are no titles or memories.
 *
 * Also runs the feedback loop: evaluates previously injected memories against
 * the new user input and adjusts importance (boost/decay).
 *
 * @param content User input
 * @param thread Thread row (references folderId and id)
 * @param userId Current user ID
 * @param currentThreadId Current thread ID (excluded from title list)
 * @param userMessageId The new user message ID (for feedback loop + injection tracking)
 */
export async function buildMemoryContext({
  content,
  thread,
  userId,
  currentThreadId,
  userMessageId,
}: {
  content: string;
  thread: { folderId: string | null; id: string };
  userId: string;
  currentThreadId: string;
  userMessageId: string;
}): Promise<{ role: "system"; content: string } | null> {
  // Run feedback loop for previously injected memories (non-blocking, errors swallowed)
  if (userMessageId) {
    try {
      await processFeedbackLoop(currentThreadId, userMessageId, content);
    } catch {
      // Feedback loop failure should not block memory injection
    }
  }
  const [found, recentTitles, profileTraits] = await Promise.all([
    findRelevantMemories(content, thread.folderId, userId),
    fetchRecentThreadTitles(userId, currentThreadId),
    findProfileTraits(userId),
  ]);

  // Record injections for the feedback loop's next cycle
  if (userMessageId && found.length > 0) {
    try {
      await recordInjections(userMessageId, found.map((m) => m.id));
    } catch {
      // Injection recording failure should not block context building
    }
  }

  const sections: string[] = [];
  if (profileTraits.length > 0) {
    const traitLines = profileTraits.map((t) => `- [${t.category}] ${t.content}`).join("\n");
    sections.push(`User traits — stable attributes about the user. Apply these in every conversation:\n${traitLines}`);
  }
  if (recentTitles.length > 0) {
    const titleList = recentTitles.map((t) => `- ${t}`).join("\n");
    sections.push(`Recent conversation topics (most recent first). Use these to infer which past conversations may be relevant to the user's current question:\n${titleList}`);
  }
  if (found.length > 0) {
    const lines = found.map((m) => `- [${m.kind}] (${formatRelativeTime(m.updatedAt)}) ${m.content}`).join("\n");
    sections.push(`Past memories from previous conversations. Use these to provide context for the user's question. If the user asks what you discussed before, summarize the relevant memories.\n${lines}`);
  }
  if (sections.length === 0) return null;
  return {
    role: "system",
    content: sections.join("\n\n"),
  };
}
