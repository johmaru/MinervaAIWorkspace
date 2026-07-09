/**
 * In environments where the LLM does not support function calling, it may output
 * tool call syntax as plain text (e.g. ```scrape_webpage urls="..."```).
 * This prevents such output from being rendered as unclosed code fences or XML tags
 * that break the UI. Also safely handles partial output during streaming.
 *
 * Used by both the client (Markdown.tsx) and the server (chat/route.ts).
 */
export function sanitizeToolCallMarkup(content: string): string {
  return content
    // Code fence format: ```tool_name ... ``` → remove
    .replace(/```(?:scrape_webpage|search_web)\b[\s\S]*?```/g, "")
    // Code fence format (during streaming): ```tool_name ... (no closing fence) → remove
    .replace(/```(?:scrape_webpage|search_web)\b[\s\S]*/g, "")
    // XML tag format: <search_web>...</search_web> → remove
    .replace(/<(?:scrape_webpage|search_web)\b[^>]*>[\s\S]*?<\/(?:scrape_webpage|search_web)>/g, "")
    // XML self-closing tag format: <search_web ... /> → remove
    .replace(/<(?:scrape_webpage|search_web)\b[^>]*\/>/g, "")
    // XML tag format (during streaming): <search_web ...>... (no closing tag) → remove
    .replace(/<(?:scrape_webpage|search_web)\b[^>]*>[\s\S]*/g, "")
    // XML tag format (during streaming, opening tag incomplete): <search_web query="... (no >) → remove
    .replace(/<(?:scrape_webpage|search_web)\b[^>]*/g, "")
    // GLM/Qwen tool_call format (complete) → remove
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/g, "")
    // GLM/Qwen tool_call format (during streaming, no closing tag) → remove
    .replace(/<tool_call\b[^>]*>[\s\S]*/g, "")
    // GLM/Qwen tool_call format (during streaming, opening tag incomplete): <tool_call ... (no >) → remove
    .replace(/<tool_call\b[^>]*/g, "")
    .trim();
}

/**
 * Determines whether the content contains tool call markup.
 * Used on the server side to decide whether continued generation is needed.
 */
export function hasToolCallMarkup(content: string): boolean {
  return (
    /```(?:scrape_webpage|search_web)\b/.test(content) ||
    /<(?:scrape_webpage|search_web)\b/.test(content) ||
    /<tool_call\b/.test(content)
  );
}
