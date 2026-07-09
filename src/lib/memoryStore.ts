import { eq, ne, and, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import { memories, folders, threads } from "@/db/schema";
import { embedText } from "@/lib/embed";
import { cosineSimilarity } from "@/lib/vectorSearch";
import type { MemoryKind } from "@/lib/memory";

/**
 * Memory search — on next send, searches for relevant memories via client-side
 * cosine similarity and returns top-5 by similarity + recency.
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
};

/**
 * Searches for relevant memories by query string and scope.
 *
 * 1. Vectorize the query via embedText(query, "query")
 * 2. Get candidate rows filtered by suppressed_at IS NULL, userId, and scope
 * 3. Compute cosine similarity client-side
 * 4. Filter by similarity > 0.3
 * 5. Return top-5 by recencyScore descending
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

  // Get candidate rows (suppressed_at IS NULL + userId filter + scope filter)
  // innerJoin threads to retrieve only memories belonging to threads owned by this user.
  const conditions = [isNull(memories.suppressedAt), eq(threads.userId, userId)];
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
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .innerJoin(threads, eq(memories.threadId, threads.id))
    .where(and(...conditions));

  if (rows.length === 0) return [];

  // Client-side cosine similarity computation + recency score
  const scored = rows
    .map((r) => {
      const sim = cosineSimilarity(queryVector, r.embedding);
      // recency: EXP(-ageDays / 14) — decays to e^-1 ≈ 0.37 after 14 days
      const ageDays = (Date.now() - new Date(r.updatedAt).getTime()) / 86_400_000;
      const recency = Math.exp(-ageDays / 14);
      const recencyScore = r.importance * 0.6 + recency * 0.4;
      return {
        id: r.id,
        threadId: r.threadId,
        kind: r.kind as MemoryKind,
        content: r.content,
        similarity: sim,
        recencyScore,
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
 * Resolves the memory search scope from the thread's folderId and builds relevant
 * memories as a system message. Also injects recent thread titles so the AI can
 * infer past conversation topics. Returns null if there are no titles or memories.
 *
 * @param content User input
 * @param thread Thread row (references folderId and id)
 * @param userId Current user ID
 * @param currentThreadId Current thread ID (excluded from title list)
 */
export async function buildMemoryContext({
  content,
  thread,
  userId,
  currentThreadId,
}: {
  content: string;
  thread: { folderId: string | null };
  userId: string;
  currentThreadId: string;
}): Promise<{ role: "system"; content: string } | null> {
  const [found, recentTitles] = await Promise.all([
    findRelevantMemories(content, thread.folderId, userId),
    fetchRecentThreadTitles(userId, currentThreadId),
  ]);

  const sections: string[] = [];
  if (recentTitles.length > 0) {
    const titleList = recentTitles.map((t) => `- ${t}`).join("\n");
    sections.push(`Recent conversation topics (most recent first). Use these to infer which past conversations may be relevant to the user's current question:\n${titleList}`);
  }
  if (found.length > 0) {
    const lines = found.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
    sections.push(`Past memories from previous conversations. Use these to provide context for the user's question. If the user asks what you discussed before, summarize the relevant memories.\n${lines}`);
  }
  if (sections.length === 0) return null;
  return {
    role: "system",
    content: sections.join("\n\n"),
  };
}
