/**
 * LLM が関数呼び出しをサポートしない環境で、ツール呼び出し構文を
 * プレーンテキストとして出力することがある（例: ```scrape_webpage urls="..."```）。
 * これが未閉鎖のコードフェンスや XML タグとして描画され、UI が崩れるのを防ぐ。
 * ストリーミング中の部分的な出力も安全に処理する。
 *
 * クライアント（Markdown.tsx）とサーバー（chat/route.ts）の両方から利用される。
 */
export function sanitizeToolCallMarkup(content: string): string {
  return content
    // コードフェンス形式: ```tool_name ... ``` → 削除
    .replace(/```(?:scrape_webpage|search_web)\b[\s\S]*?```/g, "")
    // コードフェンス形式（ストリーミング中）: ```tool_name ... （閉じフェンスなし）→ 削除
    .replace(/```(?:scrape_webpage|search_web)\b[\s\S]*/g, "")
    // XMLタグ形式: <search_web>...</search_web> → 削除
    .replace(/<(?:scrape_webpage|search_web)\b[^>]*>[\s\S]*?<\/(?:scrape_webpage|search_web)>/g, "")
    // XMLタグ自己閉鎖形式: <search_web ... /> → 削除
    .replace(/<(?:scrape_webpage|search_web)\b[^>]*\/>/g, "")
    // XMLタグ形式（ストリーミング中）: <search_web ...>...（閉じタグなし）→ 削除
    .replace(/<(?:scrape_webpage|search_web)\b[^>]*>[\s\S]*/g, "")
    // XMLタグ形式（ストリーミング中・開きタグ未完了）: <search_web query="... （> なし）→ 削除
    .replace(/<(?:scrape_webpage|search_web)\b[^>]*/g, "")
    // GLM/Qwen tool_call形式（完全形）→ 削除
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/g, "")
    // GLM/Qwen tool_call形式（ストリーミング中・閉じタグなし）→ 削除
    .replace(/<tool_call\b[^>]*>[\s\S]*/g, "")
    // GLM/Qwen tool_call形式（ストリーミング中・開きタグ未完了）: <tool_call ... （> なし）→ 削除
    .replace(/<tool_call\b[^>]*/g, "")
    .trim();
}

/**
 * コンテンツにツール呼び出しマークアップが含まれるか判定する。
 * サーバー側で継続生成の要否を決定するために使用する。
 */
export function hasToolCallMarkup(content: string): boolean {
  return (
    /```(?:scrape_webpage|search_web)\b/.test(content) ||
    /<(?:scrape_webpage|search_web)\b/.test(content) ||
    /<tool_call\b/.test(content)
  );
}
