/**
 * Scrapling microservice クライアント。
 * Next.js Route Handler から `POST /scrape` を呼ぶ薄いラッパー。
 *
 * env SCRAPER_URL:
 * - Docker Compose: http://scraper:8000
 * - ローカル開発: http://localhost:8000
 */

export type ScrapeResult = {
  url: string;
  title: string;
  content: string;
  status: number;
};

/**
 * microservice の /scrape を呼ぶ。
 * タイムアウトは microservice 側の Scrapling timeout(30s) + リトライ3回(各2s遅延) + 余裕で 45s。
 */
export async function scrapeUrl(url: string): Promise<ScrapeResult> {
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
    throw new Error(data.error || `scraper returned ${res.status}`);
  }
  return (await res.json()) as ScrapeResult;
}

/**
 * SearXNG 経由の Web 検索結果1件（スクレイピング済み）。
 */
export type WebSearchResult = {
  url: string;
  title: string;
  snippet: string; // SearXNG の content（検索結果サマリ）
  scraped: boolean;
  content: string; // スクレイピングした本文（scraped=false は空）
  scrapeTitle: string;
};

export type WebSearchResponse = {
  query: string;
  results: WebSearchResult[];
};

/**
 * チャット上の参照元表示用。scrapeTitle があれば優先。
 */
export type SourceInfo = {
  url: string;
  title: string;
  snippet: string;
};

/**
 * microservice の /search を呼ぶ（SearXNG 検索 → 上位 URL をスクレイピング）。
 * タイムアウトは SearXNG 検索(20s) + スクレイピング5件並列(30s) + 余裕で 60s。
 */
export async function searchWeb(
  query: string,
  maxResults = 5,
  timeRange?: "day" | "week" | "month" | "year",
): Promise<WebSearchResponse> {
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
    throw new Error(data.error || `search failed (${res.status})`);
  }
  return (await res.json()) as WebSearchResponse;
}

/**
 * URL を正規化。無効URLは空文字を返す。
 * - scheme は http/https のみ許可
 * - fragment 削除
 * - ルート URL 以外の末尾スラッシュ削除
 *
 * UI/API 入力バリデーション用。microservice 側でも正規化するため二重だが、
 * 無効URLで往復するコストを避けるため Next.js 側でも即時弾く。
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
