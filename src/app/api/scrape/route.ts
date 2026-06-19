import { db } from "@/db";
import { pages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashContent } from "@/lib/embed";
import { scrapeUrl, normalizeUrl } from "@/lib/scraper";
import { upsertPage } from "@/lib/pageStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { url: string };

/**
 * POST /api/scrape — Web ページをスクレイピングして知識化。
 *
 * 1. URL 正規化 + バリデーション
 * 2. urlHash で既存ページを検索（キャッシュチェック + 取得失敗時の stale 復帰用）
 * 3. microservice にスクレイプ依頼
 * 4. upsertPage で pages を upsert + page_embeddings を再生成（contentHash でキャッシュ）
 *
 * レスポンス: { id, url, title, contentPreview, cached } | { error }
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.url?.trim()) return new Response("url is required", { status: 400 });

  const normalized = normalizeUrl(body.url.trim());
  if (!normalized) return new Response("invalid url", { status: 400 });

  const urlHash = hashContent(normalized);

  // キャッシュチェック: 同一 URL で既存ページを検索（取得失敗時の stale 復帰用）
  const [existing] = await db.select().from(pages).where(eq(pages.urlHash, urlHash));

  let result: ScrapeResultLike;
  try {
    result = await scrapeUrl(normalized);
  } catch (err) {
    // 既存ページがあり取得失敗 → 古い内容を維持してキャッシュヒット扱い
    if (existing) {
      return Response.json({
        id: existing.id,
        url: existing.url,
        title: existing.title,
        cached: true,
        stale: true,
      });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "scrape failed" },
      { status: 502 },
    );
  }

  // 既存ページで contentHash が同じ → キャッシュヒット（upsertPage にも同等判定があるが、
  // ここでは contentPreview を返さず早期リターンで再 embed を含め完全にスキップ）
  const contentHash = hashContent(result.content);
  if (existing && existing.contentHash === contentHash) {
    return Response.json({
      id: existing.id,
      url: existing.url,
      title: existing.title,
      cached: true,
    });
  }

  // upsert + embed（pageStore に集約）
  const id = await upsertPage(normalized, result.title, result.content);

  return Response.json({
    id,
    url: result.url,
    title: result.title,
    contentPreview: result.content.slice(0, 200),
    cached: false,
  });
}

type ScrapeResultLike = {
  url: string;
  title: string;
  content: string;
  status: number;
};
