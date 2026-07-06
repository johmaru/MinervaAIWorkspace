/**
 * Wikipedia REST API で軽量参照する。
 * SearXNG/スクレイパー不要で直接 fetch。認証不要・無料。
 *
 * searchLevel: "wiki" の非Toolモデルパスと、search_wikipedia ツールの両方で使用。
 * 記事が見つからない・エラー時は null を返し、呼び出し元はトレーニングデータで回答する。
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
 * クエリ内容から言語を判定。
 * ひらがな・カタカナ・漢字が含まれれば ja、それ以外は en。
 * getRequestLocale（Cookie ベース）はクエリ内容判定に使えないため新規実装。
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
 * Wikipedia REST API で記事を検索し、summary を取得する。
 * opensearch でタイトル解決 → summary endpoint で抽出取得の2段階。
 *
 * @returns 記事が見つかった場合は WikipediaResult、見つからない/エラー時は null
 */
export async function searchWikipedia(query: string): Promise<WikipediaResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const lang = detectLang(trimmed);

  // (1) opensearch でタイトル解決
  const opensearchUrl = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(trimmed)}&limit=1&namespace=0&format=json`;
  let title: string | null = null;
  try {
    const res = await timeoutFetch(opensearchUrl);
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    // opensearch レスポンス: [search, [titles], [descriptions], [urls]]
    if (!Array.isArray(data) || data.length < 2) return null;
    const titles = data[1];
    if (!Array.isArray(titles) || titles.length === 0) return null;
    title = typeof titles[0] === "string" ? titles[0] : null;
  } catch {
    return null;
  }
  if (!title) return null;

  // (2) summary endpoint で抽出取得
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
