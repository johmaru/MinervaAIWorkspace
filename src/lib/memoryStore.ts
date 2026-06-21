import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { folders } from "@/db/schema";
import { embedText } from "@/lib/embed";
import type { MemoryKind } from "@/lib/memory";

/**
 * 記憶検索 — 次回送信時に pgvector で関連記憶を検索し、similarity + recency で top-5 を返す。
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
 * 2. pgvector で suppressed_at IS NULL、スコープフィルタで top-30 取得
 * 3. similarity > 0.3 でフィルタ
 * 4. recencyScore 降順で top-5 を返す
 *
 * @param query ユーザー入力
 * @param folderId 現在のスレッドの folderId（null 可）
 */
export async function findRelevantMemories(
  query: string,
  folderId: string | null,
): Promise<ScoredMemory[]> {
  const queryVector = await embedText(query, "query");
  if (queryVector.length === 0) return [];

  // スコープ判定: folderId のフォルダが memoryScope="folder" なら同フォルダのみ
  let scopeFolder: boolean = false;
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

  const vecLiteral = JSON.stringify(queryVector);
  const scopeCondition = scopeFolder
    ? sql`AND m.folder_id = ${targetFolderId}`
    : sql``;

  // pgvector 検索 + recency スコアを1クエリで取得
  const rawResults = await db.execute(sql`
    SELECT m.id, m.thread_id, m.kind, m.content,
           1 - (m.embedding <=> ${vecLiteral}::vector) as similarity,
           m.importance * 0.6 + EXP(-EXTRACT(EPOCH FROM (now() - m.updated_at)) / 86400 / 14) * 0.4 as recency_score
    FROM memories m
    WHERE m.suppressed_at IS NULL
      ${scopeCondition}
    ORDER BY m.embedding <=> ${vecLiteral}::vector
    LIMIT 30
  `);

  const rows = (rawResults as { rows?: Array<{
    id: string;
    thread_id: string;
    kind: MemoryKind;
    content: string;
    similarity: number;
    recency_score: number;
  }> }).rows ?? [];

  const filtered = rows.filter((r) => r.similarity > 0.3);
  if (filtered.length === 0) return [];

  // recencyScore 降順で top-5
  return filtered
    .map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      kind: r.kind,
      content: r.content,
      similarity: Number(r.similarity.toFixed(3)),
      recencyScore: Number(Number(r.recency_score).toFixed(3)),
    }))
    .sort((a, b) => b.recencyScore - a.recencyScore)
    .slice(0, 5);
}

/**
 * スレッドの folderId から記憶検索スコープを解決し、関連記憶を system message として構築。
 * 記憶が無い場合は null を返す（注入しない）。
 *
 * @param content ユーザー入力
 * @param thread スレッド行（folderId を参照）
 */
export async function buildMemoryContext({
  content,
  thread,
}: {
  content: string;
  thread: { folderId: string | null };
}): Promise<{ role: "system"; content: string } | null> {
  const found = await findRelevantMemories(content, thread.folderId);
  if (found.length === 0) return null;
  const lines = found.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
  return {
    role: "system",
    content: `Past memories from previous conversations. Use these to provide context for the user's question. If the user asks what you discussed before, summarize the relevant memories.\n${lines}`,
  };
}
