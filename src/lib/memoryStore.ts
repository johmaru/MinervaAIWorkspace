import { eq, ne, and, desc, sql, inArray } from "drizzle-orm";
import { db } from "@/db";
import { memories, memoryInjections, folders, threads, messages } from "@/db/schema";
import { embedText } from "@/lib/embed";
import { toVecBuffer, distanceToSimilarity } from "@/lib/vectorSearch";
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
 * 2. SQL query with vec_distance_cosine on the candidate set (filtered by userId + scope + active)
 * 3. Filter by similarity > 0.3 (distance < 0.7), top 30 by similarity
 * 4. Re-rank top 30 by recencyScore, return top 5
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
  const queryBuf = toVecBuffer(queryVector);

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

  // Build raw SQL with vec_distance_cosine — computes distance in SQLite (C + SIMD),
  // avoiding loading embeddings into JS memory.
  // activeMemoryConditions: suppressedAt IS NULL AND (validUntil IS NULL OR validUntil > now)
  //   AND (expiresAt IS NULL OR expiresAt > now)
  const now = Date.now();
  const folderCondition = scopeFolder && targetFolderId
    ? sql`AND m.folder_id = ${targetFolderId}`
    : sql``;

  const rows = await db.all(sql`
    SELECT m.id, m.thread_id, m.kind, m.content, m.importance,
           m.last_referenced_at, m.updated_at,
           vec_distance_cosine(m.embedding, ${queryBuf}) AS distance
    FROM memories m
    INNER JOIN threads t ON m.thread_id = t.id
    WHERE t.user_id = ${userId}
      AND m.suppressed_at IS NULL
      AND (m.valid_until IS NULL OR m.valid_until > ${now})
      AND (m.expires_at IS NULL OR m.expires_at > ${now})
      ${folderCondition}
      AND vec_distance_cosine(m.embedding, ${queryBuf}) < 0.7
    ORDER BY distance
    LIMIT 30
  `);

  if (rows.length === 0) return [];

  // Post-process: compute recencyScore and take top 5
  const scored = (rows as Record<string, unknown>[]).map((r) => {
    const distance = r.distance as number;
    const sim = distanceToSimilarity(distance);
    const ageDays = (now - new Date(r.updated_at as number | string).getTime()) / 86_400_000;
    const recency = Math.exp(-ageDays / 14);
    const lastRef = r.last_referenced_at as number | string | null;
    const refAgeDays = lastRef
      ? (now - new Date(lastRef).getTime()) / 86_400_000
      : Infinity;
    const refRecency = lastRef ? Math.exp(-refAgeDays / 7) : 0;
    const recencyScore = (r.importance as number) * 0.4 + recency * 0.3 + refRecency * 0.3;
    return {
      id: r.id as string,
      threadId: r.thread_id as string,
      kind: r.kind as MemoryKind,
      content: r.content as string,
      similarity: sim,
      recencyScore,
      updatedAt: new Date(r.updated_at as number | string),
    };
  });

  return scored
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

  // Find memories injected for the previous user message — with distance computed in SQL
  const queryVector = await embedText(newQuery, "query");
  if (queryVector.length === 0) return;
  const queryBuf = toVecBuffer(queryVector);

  const injected = await db.all(sql`
    SELECT mi.memory_id, m.importance,
           vec_distance_cosine(m.embedding, ${queryBuf}) AS distance
    FROM memory_injections mi
    INNER JOIN memories m ON mi.memory_id = m.id
    WHERE mi.message_id = ${prevUserMsg.id}
  `) as { memory_id: string; importance: number; distance: number }[];

  if (injected.length === 0) return;

  const now = new Date();
  db.transaction((tx) => {
    for (const mem of injected) {
      if (mem.distance < 0.5) {
        const newImportance = Math.min(1.0, mem.importance + 0.05);
        tx
          .update(memories)
          .set({ importance: newImportance, lastReferencedAt: now, updatedAt: now })
          .where(eq(memories.id, mem.memory_id))
          .run();
      } else {
        const newImportance = Math.max(0.1, mem.importance - 0.02);
        tx
          .update(memories)
          .set({ importance: newImportance, updatedAt: now })
          .where(eq(memories.id, mem.memory_id))
          .run();
      }
    }
  });
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
  db.transaction((tx) => {
    tx.insert(memoryInjections).values(rows).run();
    tx
      .update(memories)
      .set({ injectionCount: sql`${memories.injectionCount} + 1`, lastInjectedAt: now })
      .where(inArray(memories.id, memoryIds))
      .run();
  });
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
