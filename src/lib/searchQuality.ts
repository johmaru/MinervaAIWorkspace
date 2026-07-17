/**
 * Search-result quality helpers: content slicing, domain diversity,
 * thin-result detection, adaptive query rewrite, and context formatting.
 */

/** SearXNG category values we accept from the query generator. */
export type SearchCategory = "general" | "news" | "science" | "it" | null;

/** Hosts that rarely yield high-quality factual answers (hard demote / skip). */
const LOW_QUALITY_HOST_PATTERNS: RegExp[] = [
  /(^|\.)pinterest\./i,
  /(^|\.)pinimg\./i,
  /(^|\.)quora\.com$/i,
  /(^|\.)answers\.yahoo\.com$/i,
  /(^|\.)ezinearticles\.com$/i,
  /(^|\.)hubpages\.com$/i,
  /(^|\.)wikihow\.com$/i,
  /(^|\.)fandom\.com$/i,
  /(^|\.)scribd\.com$/i,
  /(^|\.)slideplayer\./i,
  /(^|\.)brainly\./i,
  /(^|\.)coursehero\.com$/i,
  /(^|\.)chegg\.com$/i,
  /(^|\.)studocu\.com$/i,
];

/** Soft-demote hosts (keep but lower score). */
const SOFT_DEMOTE_HOST_PATTERNS: RegExp[] = [
  /(^|\.)medium\.com$/i,
  /(^|\.)blogspot\./i,
  /(^|\.)wordpress\.com$/i,
  /(^|\.)tumblr\.com$/i,
];

export type DomainRankable = {
  url: string;
  score?: number;
  scraped?: boolean;
  content?: string;
  title?: string;
  snippet?: string;
};

/**
 * Extract a hostname (without www.) from a URL. Empty string on failure.
 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function isLowQualityHost(host: string): boolean {
  if (!host) return false;
  return LOW_QUALITY_HOST_PATTERNS.some((re) => re.test(host));
}

export function isSoftDemoteHost(host: string): boolean {
  if (!host) return false;
  return SOFT_DEMOTE_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * Apply domain quality rules after score ranking:
 * - skip hard low-quality hosts
 * - soft-demote medium-quality hosts (score *= 0.4)
 * - cap results per domain (default 2)
 * Re-sort by adjusted score.
 */
export function applyDomainQualityFilter<T extends DomainRankable>(
  results: T[],
  maxPerDomain = 2,
): T[] {
  if (results.length === 0) return [];

  type Adjusted = { item: T; score: number; host: string };
  const adjusted: Adjusted[] = [];
  for (const r of results) {
    const host = hostnameOf(r.url);
    if (isLowQualityHost(host)) continue;
    let score = r.score ?? 0;
    if (isSoftDemoteHost(host)) score *= 0.4;
    adjusted.push({ item: { ...r, score }, score, host });
  }
  adjusted.sort((a, b) => b.score - a.score);

  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const { item, host } of adjusted) {
    const n = counts.get(host) ?? 0;
    if (host && n >= maxPerDomain) continue;
    if (host) counts.set(host, n + 1);
    out.push(item);
  }
  return out;
}

/**
 * Slice body text around the first hit of a query term instead of always taking the head.
 * Falls back to the start when no term matches.
 */
export function sliceContentAroundQuery(
  content: string,
  query: string,
  maxLen = 2000,
): string {
  if (!content) return "";
  if (content.length <= maxLen) return content;

  const terms = query
    .replace(/site:\S+/gi, " ")
    .replace(/["'`]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 12);

  const lower = content.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (hit < 0 || idx < hit)) hit = idx;
  }

  if (hit < 0) {
    return content.slice(0, maxLen);
  }

  // Center the window slightly before the hit so surrounding context is kept
  const before = Math.floor(maxLen * 0.25);
  let start = Math.max(0, hit - before);
  if (start + maxLen > content.length) start = Math.max(0, content.length - maxLen);

  // Prefer a nearby newline/space so we don't start mid-word when cheap
  if (start > 0) {
    const window = content.slice(start, start + 40);
    const sp = window.search(/[\s\n]/);
    if (sp > 0 && sp < 30) start += sp + 1;
  }

  let slice = content.slice(start, start + maxLen);
  if (start > 0) slice = "…" + slice;
  if (start + maxLen < content.length) slice = slice + "…";
  return slice;
}

/**
 * True when results are empty or have almost no usable text for the model.
 */
export function isThinSearchResults(
  results: Array<{ title?: string; snippet?: string; content?: string; scraped?: boolean }>,
): boolean {
  if (results.length === 0) return true;
  const hasBody = results.some(
    (r) =>
      (r.scraped && (r.content?.trim().length ?? 0) >= 40) ||
      (r.content?.trim().length ?? 0) >= 40 ||
      (r.snippet?.trim().length ?? 0) >= 40,
  );
  return !hasBody;
}

/**
 * Build a broader retry query: drop site:/quotes, collapse whitespace.
 * Appends a light broaden token only when the stripped query is still non-empty.
 */
export function rewriteQueryForRetry(query: string): string {
  const stripped = query
    .replace(/site:\S+/gi, " ")
    .replace(/["'`]/g, " ")
    .replace(/[？?！!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return query.trim();
  // Avoid doubling if already rewritten
  if (/\boverview\b$/i.test(stripped)) return stripped;
  return stripped;
}

/**
 * Extract keyword-style tokens from a conversational user message for heuristic fallback.
 * Prefer alphanumeric + CJK runs; drop particles/stopwords/filler phrases.
 */
export function extractHeuristicKeywords(message: string): string {
  // Break Japanese particles into separators so they don't glue into keyword tokens
  // (e.g. 最新のレビュー → 最新 レビュー).
  const normalized = message
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(ください|下さい|教えて|調べて|確認して|どうなってる|どうですか|って何|ってなに|とは|について)/g, " ")
    .replace(/[のはがをにでとへも]/gu, " ")
    .replace(/[？?！!。、．，,・]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens =
    normalized.match(/[A-Za-z][A-Za-z0-9.\-]{1,}|[0-9]+(?:\.[0-9]+)?|[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]{2,}/g) ??
    [];

  const stop = new Set([
    "the", "a", "an", "is", "are", "was", "were", "what", "who", "how", "why", "when", "where",
    "this", "that", "with", "from", "for", "and", "or", "to", "of", "in", "on", "it",
    "です", "ます", "する", "した", "して", "いる", "ある", "なる", "れる", "こと", "もの",
    "それ", "これ", "あれ", "よう", "ため", "ので", "から", "まで", "より", "など",
  ]);

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    // Strip trailing Japanese particles that may stick to CJK runs (評価は → 評価)
    const t = raw.replace(/[のはがをにでとへも]$/u, "");
    if (t.length < 2) continue;
    const key = t.toLowerCase();
    if (stop.has(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push(t);
    if (kept.length >= 10) break;
  }
  return kept.join(" ");
}

/**
 * Format ranked results for LLM system context.
 * With many hits, shrink per-result content budget so the prompt stays usable.
 */
export function formatSearchResultsForContext(
  results: Array<{ url: string; title: string; snippet: string; content: string }>,
  options: { maxResults?: number; maxTotalChars?: number } = {},
): string {
  const maxResults = options.maxResults ?? 12;
  const maxTotalChars = options.maxTotalChars ?? 14_000;
  const sliced = results.slice(0, maxResults);
  const n = sliced.length;

  // Progressive content budget by result count
  let contentBudget = 2000;
  if (n > 6) contentBudget = 500;
  else if (n > 3) contentBudget = 1000;

  const build = (budget: number) =>
    JSON.stringify(
      sliced.map((r) => ({
        url: r.url,
        title: r.title,
        snippet: (r.snippet || "").slice(0, 200),
        content: (r.content || "").slice(0, budget),
      })),
      null,
      2,
    );

  let json = build(contentBudget);
  // If still oversized, shrink content further
  for (const budget of [contentBudget, 400, 200, 0]) {
    json = build(budget);
    if (json.length <= maxTotalChars) break;
  }
  return json;
}

/** Normalize / validate a category string from the LLM. */
export function parseSearchCategory(raw: unknown): SearchCategory {
  if (raw === "news" || raw === "science" || raw === "it" || raw === "general") return raw;
  if (raw === null || raw === undefined || raw === "") return null;
  return null;
}
