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
  /** SearXNG relevance score (higher is better). Optional for backward compat. */
  score?: number;
};

export type WebSearchResponse = {
  query: string;
  results: WebSearchResult[];
};

/**
 * Pick SearXNG language from the query text (not UI locale).
 * CJK-heavy queries → ja-JP; otherwise en-US so English keyword queries
 * are not forced through a Japanese locale filter.
 */
export function detectSearchLanguage(query: string): "ja-JP" | "en-US" {
  return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(query) ? "ja-JP" : "en-US";
}

type RankableSearchHit = {
  url: string;
  score?: number;
  scraped?: boolean;
  content?: string;
};

/**
 * Deduplicate by normalized URL and rank by SearXNG score (desc).
 * On score ties, prefer entries that already have scraped body text.
 * Empty / invalid URLs are dropped.
 */
export function dedupeAndRankSearchResults<T extends RankableSearchHit>(results: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const r of results) {
    if (!r.url || !r.url.trim()) continue;
    const key = (normalizeUrl(r.url) || r.url).toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      continue;
    }
    const existingScore = existing.score ?? 0;
    const newScore = r.score ?? 0;
    if (newScore > existingScore) {
      byKey.set(key, r);
      continue;
    }
    if (newScore === existingScore) {
      const existingQuality = existing.scraped && existing.content ? 1 : 0;
      const newQuality = r.scraped && r.content ? 1 : 0;
      if (newQuality > existingQuality) byKey.set(key, r);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

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
  language?: string,
): Promise<WebSearchResponse> {
  if (!process.env.SCRAPER_URL) return { query, results: [] };
  const t0 = Date.now();
  const base = process.env.SCRAPER_URL || "http://localhost:8000";
  const res = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: maxResults, time_range: timeRange ?? null, language: language ?? null }),
    signal: AbortSignal.timeout(60_000),
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
    // SSRF protection: block private/internal IP ranges and metadata endpoints
    const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isPrivateHost(hostname)) return "";
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("/") && s !== `${u.origin}/`) s = s.slice(0, -1);
    return s;
  } catch {
    return "";
  }
}

/**
 * Returns true for private/internal hostnames that should not be scraped.
 * Blocks: localhost, 127.0.0.0/8, 10.x, 172.16-31.x, 192.168.x,
 * 169.254.x (link-local + cloud metadata), ::1, fc00::/7, and
 * Docker-internal hostnames (scraper, embedder, searxng, tor, app).
 */
function isPrivateHost(hostname: string): boolean {
  // IPv4-mapped IPv6: ::ffff:1.2.3.4 → check as IPv4
  if (/^::ffff:/.test(hostname)) {
    return isPrivateHost(hostname.slice(7));
  }
  // Decimal IP: 2130706433 = 127.0.0.1
  if (/^\d{8,}$/.test(hostname)) {
    const num = parseInt(hostname, 10);
    if (num > 0 && num <= 0xFFFFFFFF) {
      const a = (num >>> 24) & 0xFF;
      const b = (num >>> 16) & 0xFF;
      return isPrivateHost(`${a}.${b}.0.0`) || isPrivateHost(`${a}.${b}.${(num >>> 8) & 0xFF}.${num & 0xFF}`);
    }
  }
  // IPv4 dotted-quad
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    const parts = hostname.split(".").map(Number);
    if (parts[0] === 127) return true; // loopback
    if (parts[0] === 10) return true; // private
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // private
    if (parts[0] === 192 && parts[1] === 168) return true; // private
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local + cloud metadata
    if (parts[0] === 0) return true; // 0.0.0.0
    return false;
  }
  // IPv6
  if (hostname === "::1" || hostname === "::") return true;
  if (/^f[cd]/.test(hostname)) return true; // ULA fc00::/7
  if (/^fe80:/.test(hostname)) return true; // link-local
  // Docker-internal hostnames
  const dockerHosts = ["scraper", "embedder", "searxng", "tor", "app", "cloudflared"];
  if (dockerHosts.includes(hostname)) return true;
  // localhost
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  return false;
}
