import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { skills } from "@/db/schema";
import { embedText } from "@/lib/embed";

/**
 * スキル検索・注入 — ユーザー単位の再利用可能プロンプト。
 *
 * memories がスレッド単位の時限的文脈断片であるのに対し、
 * skills はユーザー横断の恒久的な persona / behavior / knowledge。
 * pgvector で関連スキルを検索し system message として注入する。
 * ユーザーが「〇〇スキルを使って」と指定すれば名前で直接適用。
 */

export type ScoredSkill = {
  id: string;
  name: string;
  content: string;
  similarity: number;
};

type SkillRow = {
  id: string;
  name: string;
  content: string;
  similarity: number;
};

type NamedSkillRow = {
  id: string;
  name: string;
  content: string;
};

/**
 * db.execute の結果（Db 型が PgQueryResultHKT を使うため unknown になる）から
 * SkillRow 配列を型安全に抽出する。
 * pg の QueryResult は { rows: unknown[] } 形状を持ち、各行を narrows する。
 */
function isSkillRow(v: unknown): v is SkillRow {
  return (
    typeof v === "object" &&
    v !== null &&
    "id" in v &&
    "name" in v &&
    "content" in v &&
    "similarity" in v
  );
}

function extractSkillRows(result: unknown): SkillRow[] {
  if (typeof result !== "object" || result === null) return [];
  if (!("rows" in result) || !Array.isArray(result.rows)) return [];
  return result.rows.filter(isSkillRow);
}

function isNamedSkillRow(v: unknown): v is NamedSkillRow {
  return (
    typeof v === "object" &&
    v !== null &&
    "id" in v &&
    "name" in v &&
    "content" in v
  );
}

function extractNamedSkillRows(result: unknown): NamedSkillRow[] {
  if (typeof result !== "object" || result === null) return [];
  if (!("rows" in result) || !Array.isArray(result.rows)) return [];
  return result.rows.filter(isNamedSkillRow);
}

/**
 * クエリ文字列 + ユーザーID から関連スキルを検索。
 *
 * 1. embedText(query, "query") でクエリベクトル化
 * 2. pgvector で user_id スコープ、top-5 取得
 * 3. similarity > 0.3 でフィルタ
 *
 * skills は永続的（recency 減衰なし）、ユーザー横断（folder スコープなし）。
 * memories と比べてシンプル — similarity のみでソート。
 *
 * @param query ユーザー入力
 * @param userId スキル所有者
 * @param limit 取得上限（省略時 5）
 */
export async function findRelevantSkills(
  query: string,
  userId: string,
  limit = 5,
): Promise<ScoredSkill[]> {
  const queryVector = await embedText(query, "query");
  if (queryVector.length === 0) return [];

  const vecLiteral = JSON.stringify(queryVector);

  const rawResults = await db.execute(sql`
    SELECT id, name, content,
           1 - (embedding <=> ${vecLiteral}::vector) AS similarity
    FROM skills
    WHERE user_id = ${userId}
    ORDER BY embedding <=> ${vecLiteral}::vector
    LIMIT ${limit}
  `);

  const rows = extractSkillRows(rawResults);
  return rows
    .filter((r) => r.similarity > 0.3)
    .map((r) => ({
      id: r.id,
      name: r.name,
      content: r.content,
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
}: {
  content: string;
  userId: string;
}): Promise<{ role: "system"; content: string } | null> {
  // 手動スキル名抽出: "〇〇スキルを使って" / "use 〇〇 skill"
  const nameMatch =
    content.match(/(.+?)スキルを使っ(?:て|え)/) ??
    content.match(/use\s+(.+?)\s+skill/i);
  let namedSkill: ScoredSkill | undefined;
  if (nameMatch) {
    const name = nameMatch[1].trim();
    if (name) {
      // 名前で部分一致検索（ILIKE）。drizzle に ILIKE ヘルパーがないため
      // raw SQL で name ILIKE '%keyword%' を実行。
      const pattern = `%${name.replace(/[%_]/g, "\\$&")}%`;
      const rawNamed = await db.execute(sql`
        SELECT id, name, content FROM skills
        WHERE user_id = ${userId} AND name ILIKE ${pattern}
        LIMIT 1
      `);
      const namedRows = extractNamedSkillRows(rawNamed);
      const found = namedRows[0];
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
