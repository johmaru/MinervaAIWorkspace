import { normalizeUrl } from "@/lib/scraper";

/**
 * Upper limit on the number of URLs to extract. Prevents DoS via mass pasting.
 */
const MAX_URLS = 10;

/**
 * Extracts URLs from the body of a user message.
 *
 * - Extracts all tokens starting with `https?://`
 * - Also includes the url part of Markdown links `[text](url)` (regex captures the URL inside parentheses)
 * - Filters out invalid URLs via `normalizeUrl` (non-http/https schemes become empty)
 * - Deduplicates (preserving first-seen order)
 * - Truncates at `MAX_URLS` entries
 *
 * @returns Array of URLs. Empty array if none found.
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];

  // Extract tokens starting with `https?://` and consuming all non-whitespace/non-newline characters.
  // Trailing punctuation, parentheses, and quotes are stripped.
  const raw = text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const token of raw) {
    const cleaned = token.replace(/[.,;:!?)\]}'"]+$/u, "");
    const normalized = normalizeUrl(cleaned);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_URLS) break;
  }

  return out;
}
