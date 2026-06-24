import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  query: string;
  threadId?: string; // 現在のスレッド（除外対象、省略可）
};

/**
 * POST /api/search — セマンティック検索。
 *
 * ユーザー入力を embedding し、pgvector のコサイン距離で
 * memories テーブルから関連記憶を検索（スレッド横断）。
 * 別途 page_embeddings から Web 知識ページを検索。
 *
 * レスポンス: { results: [{ memoryId, threadId, threadTitle, kind, content, similarity }], pages: [...] }
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.query?.trim()) return Response.json({ results: [], pages: [] });

  const { embedText } = await import("@/lib/embed");
  const queryVector = await embedText(body.query.trim(), "query");
  if (queryVector.length === 0) return Response.json({ results: [], pages: [] });

  const excludeClause = body.threadId
    ? sql`AND m.thread_id != ${body.threadId}`
    : sql``;

  const rawResults = await db.execute(sql`
    SELECT m.id as memory_id, m.thread_id, t.title as thread_title,
           m.kind, m.content,
           1 - (m.embedding <=> ${JSON.stringify(queryVector)}::vector) as similarity
    FROM memories m
    JOIN threads t ON m.thread_id = t.id
    WHERE m.suppressed_at IS NULL AND t.user_id = ${user.id}
      ${excludeClause}
    ORDER BY m.embedding <=> ${JSON.stringify(queryVector)}::vector
    LIMIT 10
  `);

  const rows = (rawResults as { rows?: Array<{
    memory_id: string;
    thread_id: string;
    thread_title: string;
    kind: string;
    content: string;
    similarity: number;
  }> }).rows ?? [];

  const results = rows
    .filter((r) => r.similarity > 0.3)
    .map((r) => ({
      memoryId: r.memory_id,
      threadId: r.thread_id,
      threadTitle: r.thread_title,
      kind: r.kind as "fact" | "working",
      content: r.content.slice(0, 200),
      similarity: Number(r.similarity.toFixed(3)),
    }));

  // ページ検索: queryVector を再利用（2回目の embedText は呼ばない）
  const pageRaw = await db.execute(sql`
    SELECT p.id, p.url, p.title, p.content,
           1 - (e.embedding <=> ${JSON.stringify(queryVector)}::vector) as similarity
    FROM page_embeddings e
    JOIN pages p ON e.page_id = p.id
    ORDER BY e.embedding <=> ${JSON.stringify(queryVector)}::vector
    LIMIT 5
  `);
  const pageRows = (pageRaw as { rows?: Array<{
    id: string;
    url: string;
    title: string | null;
    content: string;
    similarity: number;
  }> }).rows ?? [];
  const pageResults = pageRows
    .filter((r) => r.similarity > 0.3)
    .map((r) => ({
      pageId: r.id,
      url: r.url,
      title: r.title ?? "",
      content: r.content.slice(0, 200),
      similarity: Number(r.similarity.toFixed(3)),
    }));

  return Response.json({ results, pages: pageResults });
}
