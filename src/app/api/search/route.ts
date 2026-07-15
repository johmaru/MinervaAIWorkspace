import { db } from "@/db";
import { eq, and, ne, sql } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText } from "@/lib/embed";
import { toVecBuffer, distanceToSimilarity } from "@/lib/vectorSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  query: string;
  threadId?: string; // Current thread (excluded from results, optional)
};

/**
 * POST /api/search — Semantic search.
 *
 * Embeds the user input and searches the memories table for related
 * memories using sqlite-vec vec_distance_cosine (cross-thread).
 * Also searches page_embeddings for web knowledge pages.
 *
 * Response: { results: [{ memoryId, threadId, threadTitle, kind, content, similarity }], pages: [...] }
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
  const queryBuf = toVecBuffer(queryVector);
  const now = Date.now();

  const threadExclude = body.threadId
    ? sql`AND m.thread_id != ${body.threadId}`
    : sql``;

  // ── Memory search: memories + threads JOIN, vec_distance_cosine ──
  const memRows = await db.all(sql`
    SELECT m.id AS memory_id, m.thread_id, t.title AS thread_title,
           m.kind, m.content,
           vec_distance_cosine(m.embedding, ${queryBuf}) AS distance
    FROM memories m
    INNER JOIN threads t ON m.thread_id = t.id
    WHERE t.user_id = ${user.id}
      AND m.suppressed_at IS NULL
      AND (m.valid_until IS NULL OR m.valid_until > ${now})
      AND (m.expires_at IS NULL OR m.expires_at > ${now})
      ${threadExclude}
      AND vec_distance_cosine(m.embedding, ${queryBuf}) < 0.7
    ORDER BY distance
    LIMIT 10
  `) as { memory_id: string; thread_id: string; thread_title: string; kind: string; content: string; distance: number }[];

  const results = memRows.map((r) => ({
    memoryId: r.memory_id,
    threadId: r.thread_id,
    threadTitle: r.thread_title,
    kind: r.kind as "fact" | "working",
    content: r.content.slice(0, 200),
    similarity: Number(distanceToSimilarity(r.distance).toFixed(3)),
  }));

  // ── Page search: page_embeddings + pages JOIN, vec_distance_cosine ──
  const pageRows = await db.all(sql`
    SELECT p.id, p.url, p.title, p.content,
           vec_distance_cosine(pe.embedding, ${queryBuf}) AS distance
    FROM page_embeddings pe
    INNER JOIN pages p ON pe.page_id = p.id
    WHERE vec_distance_cosine(pe.embedding, ${queryBuf}) < 0.7
    ORDER BY distance
    LIMIT 5
  `) as { id: string; url: string; title: string | null; content: string; distance: number }[];

  const pageResults = pageRows.map((r) => ({
    pageId: r.id,
    url: r.url,
    title: r.title ?? "",
    content: r.content.slice(0, 200),
    similarity: Number(distanceToSimilarity(r.distance).toFixed(3)),
  }));

  return Response.json({ results, pages: pageResults });
}
