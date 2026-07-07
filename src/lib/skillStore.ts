import { eq, like, and } from "drizzle-orm";
import { db } from "@/db";
import { skills } from "@/db/schema";
import { embedText } from "@/lib/embed";
import { cosineSimilarity } from "@/lib/vectorSearch";

/**
 * スキル検索・注入 — ユーザー単位の再利用可能プロンプト。
 *
 * memories がスレッド単位の時限的文脈断片であるのに対し、
 * skills はユーザー横断の恒久的な persona / behavior / knowledge。
 * アプリ側 cosine 検索で関連スキルを検索し system message として注入する。
 * ユーザーが「〇〇スキルを使って」と指定すれば名前で直接適用。
 */

export type ScoredSkill = {
  id: string;
  name: string;
  content: string;
  similarity: number;
};

/**
 * クエリ文字列 + ユーザーID から関連スキルを検索。
 *
 * 1. embedText(query, "query") でクエリベクトル化
 * 2. ユーザーの全スキルを取得
 * 3. アプリ側 cosine similarity で類似度計算
 * 4. similarity > 0.3 でフィルタ
 * 5. similarity 降順で top-limit を返す
 */
export async function findRelevantSkills(
  query: string,
  userId: string,
  limit = 5,
): Promise<ScoredSkill[]> {
  const queryVector = await embedText(query, "query");
  if (queryVector.length === 0) return [];

  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      content: skills.content,
      embedding: skills.embedding,
    })
    .from(skills)
    .where(and(eq(skills.userId, userId), eq(skills.status, "active")));
  if (rows.length === 0) return [];

  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      content: r.content,
      similarity: cosineSimilarity(queryVector, r.embedding),
    }))
    .filter((r) => r.similarity > 0.3)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .map((r) => ({
      ...r,
      similarity: Number(r.similarity.toFixed(3)),
    }));
}

/**
 * ユーザー入力から関連スキルを検索し system message として構築。
 * スキルが無い場合は null を返す（注入しない）。
 *
 * 手動スキル指定（Phase 4）:
 * ユーザーが「〇〇スキルを使って」「use 〇〇 skill」と入力した場合、
 * 名前で部分一致検索し、該当スキルを先頭に付与する。
 *
 * @param content ユーザー入力
 * @param userId スキル所有者
 */
export async function buildSkillContext({
  content,
  userId,
  threadId,
}: {
  content: string;
  userId: string;
  threadId?: string;
}): Promise<{ role: "system"; content: string } | null> {
  // 手動スキル名抽出: "〇〇スキルを使って" / "use 〇〇 skill"
  const nameMatch =
    content.match(/(.+?)スキルを使っ(?:て|え)/) ??
    content.match(/use\s+(.+?)\s+skill/i);
  let namedSkill: ScoredSkill | undefined;
  if (nameMatch) {
    const name = nameMatch[1].trim();
    if (name) {
      // 名前で部分一致検索。SQLite の LIKE はデフォルトで大文字小文字を区別しない。
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

  // セマンティック検索
  const semantic = await findRelevantSkills(content, userId);

  // 名前指定スキルを先頭に付与（重複除外）
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
  const lines = merged.map((s) => `- [${s.name}] ${s.content}`).join("\n");
  return {
    role: "system",
    content: `Active skills for this conversation. Follow these instructions:\n${lines}`,
  };
}
