import { eq, ne, and, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import { memories, folders, threads } from "@/db/schema";
import { embedText } from "@/lib/embed";
import { cosineSimilarity } from "@/lib/vectorSearch";
import type { MemoryKind } from "@/lib/memory";

/**
 * 記憶検索 — 次回送信時にアプリ側 cosine 検索で関連記憶を検索し、
 * similarity + recency で top-5 を返す。
 *
 * スコープ:
 * - folderId のフォルダが memoryScope="folder" → 同一 folderId のみ検索
 * - それ以外（global または folderId なし）→ 全スレッド横断
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
 * クエリ文字列 + スコープから関連記憶を検索。
 *
 * 1. embedText(query, "query") でクエリベクトル化
 * 2. suppressed_at IS NULL、userId 絞り込み、スコープフィルタで候補行を取得
 * 3. アプリ側 cosine similarity で類似度計算
 * 4. similarity > 0.3 でフィルタ
 * 5. recencyScore 降順で top-5 を返す
 *
 * @param query ユーザー入力
 * @param folderId 現在のスレッドの folderId（null 可）
 * @param userId 記憶を所有するユーザーの ID（他ユーザーの記憶漏洩防止）
 */
export async function findRelevantMemories(
  query: string,
  folderId: string | null,
  userId: string,
): Promise<ScoredMemory[]> {
  const queryVector = await embedText(query, "query");
  if (queryVector.length === 0) return [];

  // スコープ判定: folderId のフォルダが memoryScope="folder" なら同フォルダのみ
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

  // 候補行を取得（suppressed_at IS NULL + userId 絞り込み + スコープフィルタ）
  // innerJoin で threads を経由し、当該ユーザーが所有するスレッドの記憶のみ取得。
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

  // アプリ側 cosine similarity 計算 + recency スコア
  const scored = rows
    .map((r) => {
      const sim = cosineSimilarity(queryVector, r.embedding);
      // recency: EXP(-経過日数 / 14) — 14日で e^-1 ≈ 0.37 に減衰
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

  // similarity 降順で top-30 → recencyScore 降順で top-5
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
 * ユーザーの直近スレッドタイトルを取得（現在のスレッドと空タイトルを除外）。
 * 記憶コンテキストと一緒に AI に渡し、過去の会話トピックを推測させる。
 *
 * @param userId 現在のユーザー ID
 * @param currentThreadId 現在のスレッド ID（結果から除外）
 * @param limit 取得上限（デフォルト 15）
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
 * スレッドの folderId から記憶検索スコープを解決し、関連記憶を system message として構築。
 * 併せて直近のスレッドタイトル一覧を注入し、AI が過去の会話トピックを推測できるようにする。
 * タイトルも記憶も無い場合は null を返す（注入しない）。
 *
 * @param content ユーザー入力
 * @param thread スレッド行（folderId・id を参照）
 * @param userId 現在のユーザー ID
 * @param currentThreadId 現在のスレッド ID（タイトル一覧から除外）
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
