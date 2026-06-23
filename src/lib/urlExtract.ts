import { normalizeUrl } from "@/lib/scraper";

/**
 * URL 抽出数の上限。大量貼り付けによる DoS 回避。
 */
const MAX_URLS = 10;

/**
 * ユーザーメッセージ本文から URL を抽出する。
 *
 * - `https?://` で始まるトークンを全て抽出
 * - Markdown リンク `[text](url)` の url 部も含む（正規表現で括弧内 URL を捕捉）
 * - `normalizeUrl` で無効 URL を弾く（scheme が http/https 以外は空になる）
 * - 重複排除（初出順を保持）
 * - 上限 `MAX_URLS` 件で打ち切り
 *
 * @returns URL 配列。0件の場合は空配列。
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];

  // `https?://` で始まり、空白・改行以外の文字を消費するトークンを抽出。
  // 末尾の句読点・括弧・クォートは取り除く。
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
