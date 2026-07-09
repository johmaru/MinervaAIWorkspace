/**
 * Lightweight reference via the Wikipedia REST API.
 * Fetches directly without SearXNG/scraper. No auth required, free.
 *
 * Used in both the searchLevel: "wiki" non-Tool model path and the search_wikipedia tool.
 * Returns null when the article is not found or on error; the caller answers from training data.
 */

export type WikipediaResult = {
  title: string;
  description: string;
  extract: string;
  url: string;
  lang: "ja" | "en";
};

const USER_AGENT = "UmansChat/1.0 (https://github.com/johmaru/UmansChat-Unofficial)";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Detects the language from the query content.
 * Returns "ja" if hiragana, katakana, or kanji are present; otherwise "en".
 * getRequestLocale (cookie-based) cannot be used for query content detection, so this is a separate implementation.
 */
function detectLang(query: string): "ja" | "en" {
  return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(query) ? "ja" : "en";
}

function timeoutFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/**
 * Searches for an article via the Wikipedia REST API and retrieves its summary.
 * Two stages: title resolution via opensearch → extract retrieval via the summary endpoint.
 *
 * @returns WikipediaResult if the article is found; null if not found or on error
 */
export async function searchWikipedia(query: string): Promise<WikipediaResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const lang = detectLang(trimmed);

  // (1) Title resolution via opensearch
  const opensearchUrl = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(trimmed)}&limit=1&namespace=0&format=json`;
  let title: string | null = null;
  try {
    const res = await timeoutFetch(opensearchUrl);
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    // opensearch response: [search, [titles], [descriptions], [urls]]
    if (!Array.isArray(data) || data.length < 2) return null;
    const titles = data[1];
    if (!Array.isArray(titles) || titles.length === 0) return null;
    title = typeof titles[0] === "string" ? titles[0] : null;
  } catch {
    return null;
  }
  if (!title) return null;

  // (2) Extract retrieval via the summary endpoint
  const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try {
    const res = await timeoutFetch(summaryUrl);
    if (!res.ok) return null;
    const summary = (await res.json()) as {
      title?: string;
      description?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    const resultUrl =
      summary.content_urls?.desktop?.page ??
      `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    return {
      title: summary.title ?? title,
      description: summary.description ?? "",
      extract: summary.extract ?? "",
      url: resultUrl,
      lang,
    };
  } catch {
    return null;
  }
}
