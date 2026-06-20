import type OpenAI from "openai";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { folders } from "@/db/schema";
import { embedText } from "@/lib/embed";
import type { MemoryKind } from "@/lib/memory";

/**
 * 記憶検索 — 次回送信時に pgvector で関連記憶を検索し、LLM rerank + recency で top-5 を返す。
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

const RERANK_SYSTEM_PROMPT = `You are a memory relevance ranker.
Given a user question and a list of memories, select the indices of the memories most useful for answering the question.
Return ONLY valid JSON: {"indices": [0, 3, 5]}
Pick at most 8 indices. Pick fewer if only a few are relevant. Pick none if none are relevant.`;

/**
 * クエリ文字列 + スコープから関連記憶を検索。
 *
 * 1. embedText(query, "query") でクエリベクトル化
 * 2. pgvector で suppressed_at IS NULL、スコープフィルタで top-30 取得
 * 3. similarity > 0.3 でフィルタ
 * 4. LLM rerank で top-8 選出（失敗時は similarity 順 top-8 にフォールバック）
 * 5. recencyScore 降順で top-5 を返す
 *
 * @param query ユーザー入力
 * @param folderId 現在のスレッドの folderId（null 可）
 * @param llm LLM クライアント（テスト注入可）
 * @param model LLM モデル id
 */
export async function findRelevantMemories(
  query: string,
  folderId: string | null,
  llm: OpenAI,
  model: string,
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

  // LLM rerank: top-30 の content を渡し top-8 を選出
  const rerankedIndices = await rerankMemories(query, filtered.map((r) => r.content), llm, model);

  // rerank 結果で並び替え（失敗時は similarity 順）
  let topCandidates: typeof filtered;
  if (rerankedIndices && rerankedIndices.length > 0) {
    topCandidates = rerankedIndices
      .filter((i) => i >= 0 && i < filtered.length)
      .map((i) => filtered[i]);
  } else {
    topCandidates = [...filtered].sort((a, b) => b.similarity - a.similarity).slice(0, 8);
  }

  // recencyScore 降順で top-5
  return topCandidates
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
 * LLM で記憶の関連度を rerank。
 * 失敗時は null を返し、呼び出し元で similarity 順にフォールバック。
 */
async function rerankMemories(
  query: string,
  contents: string[],
  llm: OpenAI,
  model: string,
): Promise<number[] | null> {
  if (contents.length === 0) return null;
  const list = contents.map((c, i) => `${i}: ${c}`).join("\n");

  try {
    const completion = await llm.chat.completions.create({
      model,
      messages: [
        { role: "system", content: RERANK_SYSTEM_PROMPT },
        { role: "user", content: `Question: ${query}\n\nMemories:\n${list}` },
      ],
    });
    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) return null;
    const stripped = raw
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(stripped) as { indices?: unknown };
    if (!Array.isArray(parsed.indices)) return null;
    return parsed.indices.filter((i): i is number => typeof i === "number" && Number.isInteger(i));
  } catch {
    return null;
  }
}

/**
 * スレッドの folderId から記憶検索スコープを解決し、関連記憶を system message として構築。
 * 記憶が無い場合は null を返す（注入しない）。
 *
 * @param content ユーザー入力
 * @param thread スレッド行（folderId を参照）
 * @param llm LLM クライアント
 * @param model LLM モデル id
 */
export async function buildMemoryContext({
  content,
  thread,
  llm,
  model,
}: {
  content: string;
  thread: { folderId: string | null };
  llm: OpenAI;
  model: string;
}): Promise<{ role: "system"; content: string } | null> {
  const found = await findRelevantMemories(content, thread.folderId, llm, model);
  if (found.length === 0) return null;
  const lines = found.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
  return {
    role: "system",
    content: `Past memories from previous conversations (use when relevant, ignore if not):\n${lines}`,
  };
}
