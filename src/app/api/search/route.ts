import { db } from "@/db";
import { memories, threads, pageEmbeddings, pages } from "@/db/schema";
import { eq, and, isNull, ne } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText } from "@/lib/embed";
import { cosineSimilarity } from "@/lib/vectorSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  query: string;
  threadId?: string; // 現在のスレッド（除外対象、省略可）
};

/**
 * POST /api/search — セマンティック検索。
 *
 * ユーザー入力を embedding し、アプリ側 cosine 類似度で
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

  const queryVector = await embedText(body.query.trim(), "query");
  if (queryVector.length === 0) return Response.json({ results: [], pages: [] });

  // ── 記憶検索: memories + threads JOIN ──
  const memoryConditions = [
    eq(threads.userId, user.id),
    isNull(memories.suppressedAt),
    ...(body.threadId ? [ne(memories.threadId, body.threadId)] : []),
  ];

  const memRows = await db
    .select({
      memoryId: memories.id,
      threadId: memories.threadId,
      threadTitle: threads.title,
      kind: memories.kind,
      content: memories.content,
      embedding: memories.embedding,
    })
    .from(memories)
    .innerJoin(threads, eq(memories.threadId, threads.id))
    .where(and(...memoryConditions));

  const results = memRows
    .map((r) => ({
      memoryId: r.memoryId,
      threadId: r.threadId,
      threadTitle: r.threadTitle,
      kind: r.kind as "fact" | "working",
      content: r.content.slice(0, 200),
      similarity: cosineSimilarity(queryVector, r.embedding),
    }))
    .filter((r) => r.similarity > 0.3)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10)
    .map((r) => ({
      ...r,
      similarity: Number(r.similarity.toFixed(3)),
    }));

  // ── ページ検索: page_embeddings + pages JOIN ──
  const pageRows = await db
    .select({
      id: pages.id,
      url: pages.url,
      title: pages.title,
      content: pages.content,
      embedding: pageEmbeddings.embedding,
    })
    .from(pageEmbeddings)
    .innerJoin(pages, eq(pageEmbeddings.pageId, pages.id));

  const pageResults = pageRows
    .map((r) => ({
      pageId: r.id,
      url: r.url,
      title: r.title ?? "",
      content: r.content.slice(0, 200),
      similarity: cosineSimilarity(queryVector, r.embedding),
    }))
    .filter((r) => r.similarity > 0.3)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
    .map((r) => ({
      ...r,
      similarity: Number(r.similarity.toFixed(3)),
    }));

  return Response.json({ results, pages: pageResults });
}
