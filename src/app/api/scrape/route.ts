import { db } from "@/db";
import { pages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashContent } from "@/lib/embed";
import { scrapeUrl, normalizeUrl } from "@/lib/scraper";
import { upsertPage } from "@/lib/pageStore";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { url: string };

/**
 * POST /api/scrape — Scrapes a web page and converts it to knowledge.
 *
 * 1. URL normalization + validation
 * 2. Search for existing page by urlHash (cache check + stale recovery on fetch failure)
 * 3. Request scrape from microservice
 * 4. Upsert pages via upsertPage + regenerate page_embeddings (cached by contentHash)
 *
 * Response: { id, url, title, contentPreview, cached } | { error }
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

  if (!body.url?.trim()) return new Response("url is required", { status: 400 });

  const normalized = normalizeUrl(body.url.trim());
  if (!normalized) return new Response("invalid url", { status: 400 });

  const urlHash = hashContent(normalized);

  // Cache check: search for existing page by URL (for stale recovery on fetch failure)
  const [existing] = await db.select().from(pages).where(eq(pages.urlHash, urlHash));

  let result: ScrapeResultLike | null;
  try {
    result = await scrapeUrl(normalized);
  } catch (err) {
    // Existing page found but fetch failed → keep stale content and treat as cache hit
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
  // Scraper service unavailable (SCRAPER_URL not configured). Fall back to
  // cached page if available, otherwise return a clear 503.
  if (result === null) {
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
      { error: "scraper service unavailable (SCRAPER_URL not configured)" },
      { status: 503 },
    );
  }

  // Existing page with same contentHash → cache hit (upsertPage has equivalent logic,
  // but here we skip entirely including re-embedding by returning early without contentPreview)
  const contentHash = hashContent(result.content);
  if (existing && existing.contentHash === contentHash) {
    return Response.json({
      id: existing.id,
      url: existing.url,
      title: existing.title,
      cached: true,
    });
  }

  // Upsert + embed (aggregated in pageStore)
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
