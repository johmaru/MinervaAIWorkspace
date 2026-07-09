/**
 * Scrapling microservice client.
 * A thin wrapper that calls `POST /scrape` from Next.js Route Handlers.
 *
 * env SCRAPER_URL:
 * - Docker Compose: http://scraper:8000
 * - Local development: http://localhost:8000
 */
import { db } from "@/db";
import { pages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashContent } from "@/lib/embed";
import { upsertPage } from "@/lib/pageStore";
import { logger } from "@/lib/logger";

export type ScrapeResult = {
  url: string;
  title: string;
  content: string;
  status: number;
};

/**
 * Calls the microservice's /scrape endpoint.
 * Timeout is 45s: microservice-side Scrapling timeout(30s) + 3 retries (2s delay each) + margin.
 */
export async function scrapeUrl(url: string): Promise<ScrapeResult | null> {
  if (!process.env.SCRAPER_URL) return null;
  const t0 = Date.now();
  const base = process.env.SCRAPER_URL || "http://localhost:8000";
  const res = await fetch(`${base}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
      error?: string;
    };
    logger.info("search-timing", "scrapeUrl", { url, duration: Date.now() - t0, ok: false });
    throw new Error(data.error || `scraper returned ${res.status}`);
  }
  logger.info("search-timing", "scrapeUrl", { url, duration: Date.now() - t0, ok: true });
  return (await res.json()) as ScrapeResult;
}

/**
 * A single web search result via SearXNG (already scraped).
 */
export type WebSearchResult = {
  url: string;
  title: string;
  snippet: string; // SearXNG content (search result summary)
  scraped: boolean;
  content: string; // Scraped body text (empty when scraped=false)
  scrapeTitle: string;
  raw_content: string; // SearXNG full content (fallback when scraping fails)
};

export type WebSearchResponse = {
  query: string;
  results: WebSearchResult[];
};

/**
 * For displaying source references in the chat UI. Uses scrapeTitle if available.
 */
export type SourceInfo = {
  url: string;
  title: string;
  snippet: string;
};

/**
 * Calls the microservice's /search endpoint (SearXNG search → scrape top URLs).
 * Timeout is 60s: SearXNG search(20s) + 5 parallel scrapes(30s) + margin.
 */
export async function searchWeb(
  query: string,
  maxResults = 5,
  timeRange?: "day" | "week" | "month" | "year",
): Promise<WebSearchResponse> {
  if (!process.env.SCRAPER_URL) return { query, results: [] };
  const t0 = Date.now();
  const base = process.env.SCRAPER_URL || "http://localhost:8000";
  const res = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: maxResults, time_range: timeRange ?? null }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
      error?: string;
    };
    logger.info("search-timing", "searchWeb", { query, duration: Date.now() - t0, ok: false });
    throw new Error(data.error || `search failed (${res.status})`);
  }
  const response = (await res.json()) as WebSearchResponse;

  // Supplement body text from DB cache: fill in results where scraped=false or content is empty using the pages table
  for (const r of response.results) {
    if (!r.scraped || !r.content) {
      const urlHash = hashContent(r.url);
      const [existing] = await db.select().from(pages).where(eq(pages.urlHash, urlHash));
      if (existing && existing.content) {
        r.scraped = true;
        r.content = existing.content;
        r.scrapeTitle = existing.title || r.title;
      }
    }
  }

  // Save newly scraped results to DB (async, errors ignored, embed runs)
  for (const r of response.results) {
    if (r.scraped && r.content) {
      upsertPage(r.url, r.scrapeTitle || r.title, r.content).catch(() => {});
    }
  }

  logger.info("search-timing", "searchWeb", { query, duration: Date.now() - t0, results: response.results.length });
  return response;
}

/**
 * Normalizes a URL. Returns empty string for invalid URLs.
 * - Only http/https schemes are allowed
 * - Fragment is removed
 * - Trailing slash is removed (except for root URLs)
 *
 * For UI/API input validation. The microservice also normalizes, so this is
 * redundant, but it rejects invalid URLs on the Next.js side to avoid round-trip costs.
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("/") && s !== `${u.origin}/`) s = s.slice(0, -1);
    return s;
  } catch {
    return "";
  }
}
