/**
 * Agent lifecycle hooks (OMP-style rules/hooks for the chat tool loop).
 *
 * These are server-side, deterministic, and always run — they do not rely on
 * the model remembering "write a user-visible answer".
 *
 * Hooks:
 * 1. recordToolResult — keep a transcript of tool outputs
 * 2. shouldForceFinalAnswer — need an LLM content turn after tools
 * 3. buildForcedReportPrompt — system prompt with tool transcript attached
 * 4. formatAutoUserReport — last-resort body when the model still emits no content
 */

export type ToolTranscriptEntry = {
  name: string;
  content: string;
  round: number;
};

/** Minimum non-whitespace chars that count as a real user-facing answer. */
export const MIN_USER_VISIBLE_CHARS = 24;

export function hasUserVisibleContent(emittedContentChars: number): boolean {
  return emittedContentChars >= MIN_USER_VISIBLE_CHARS;
}

/**
 * Record one tool execution. Truncates huge payloads so the recovery prompt
 * and auto-report stay within context limits.
 */
export function recordToolResult(
  transcript: ToolTranscriptEntry[],
  entry: ToolTranscriptEntry,
  maxContentChars = 4000,
): void {
  const content =
    entry.content.length > maxContentChars
      ? entry.content.slice(0, maxContentChars) +
        `\n…(truncated, ${entry.content.length} chars total)`
      : entry.content;
  transcript.push({ ...entry, content });
}

/**
 * After the main stream loop: force a tools-off "report in content" turn when
 * the user has not yet received a real answer body.
 *
 * - Completely empty content → always force (thinking-only hang).
 * - Tiny content after tools → force (tools ran but no real report).
 * - Tiny content without tools (e.g. "OK") → leave alone (avoid double streams).
 */
export function shouldForceFinalAnswer(args: {
  emittedContentChars: number;
  toolRounds: number;
  toolResultCount?: number;
}): boolean {
  if (hasUserVisibleContent(args.emittedContentChars)) return false;
  if (args.emittedContentChars === 0) return true;
  const usedTools = args.toolRounds > 0 || (args.toolResultCount ?? 0) > 0;
  return usedTools;
}

/**
 * System prompt for the forced final content turn. Includes recent tool
 * outputs so the model can quote real kb_id / counts without re-calling tools.
 */
export function buildForcedReportPrompt(tools: ToolTranscriptEntry[]): string {
  const header =
    "POST-TOOL / FINAL REPORT HOOK (mandatory — like a system rule):\n" +
    "You MUST write the full user-facing answer in message CONTENT now.\n" +
    "Thinking is NOT visible as the answer. Do NOT call tools.\n" +
    "Report: progress, file paths written, KB ids, ingest counts, search hits, errors, next steps.\n" +
    "Only use facts present in the tool results below (or earlier tool messages). Do not invent fields.\n" +
    "CRITICAL: If any tool result shows status=error, status=empty, or status=blocked, " +
    "report that failure honestly. Do NOT claim success when a tool returned an error or empty result. " +
    "Quote the actual tool output to support your claims.";

  if (tools.length === 0) {
    return (
      header +
      "\n\nNo tool results were recorded this turn. Say what you could not complete and what the user should try next."
    );
  }

  const recent = tools.slice(-10);
  const body = recent
    .map(
      (t, i) =>
        `### Tool ${i + 1}: ${t.name} (round ${t.round})\n${t.content}`,
    )
    .join("\n\n");

  return `${header}\n\n## Tool results (report these to the user)\n\n${body}`;
}

/**
 * Deterministic fallback when the model still produces no content after recovery.
 * Guarantees a non-empty assistant body so the UI never ends on thinking-only.
 */
export function formatAutoUserReport(args: {
  locale: "ja" | "en";
  tools: ToolTranscriptEntry[];
  toolRounds: number;
}): string {
  const { locale, tools, toolRounds } = args;

  if (tools.length === 0) {
    return locale === "ja"
      ? "【自動報告】回答本文が生成されませんでした（thinking のみ）。ツール実行も記録されていません。再送信するか、手順を短く分けて依頼してください。"
      : "[Auto-report] No user-visible answer was produced (thinking only), and no tool results were recorded. Retry or split the task.";
  }

  const lines: string[] =
    locale === "ja"
      ? [
          "【自動報告】モデルが本文を出さなかったため、ツール結果から進捗をまとめました。",
          `ツールラウンド数: ${toolRounds}`,
          `ツール実行回数: ${tools.length}`,
          "",
        ]
      : [
          "[Auto-report] The model produced no message body; summarizing tool results.",
          `Tool rounds: ${toolRounds}`,
          `Tool calls: ${tools.length}`,
          "",
        ];

  for (const t of tools.slice(-12)) {
    const statusMatch = t.content.match(/status=(\w+)/);
    const statusTag = statusMatch ? ` [${statusMatch[1]}]` : "";
    const snippet = t.content.replace(/\s+/g, " ").trim().slice(0, 500);
    lines.push(`- **${t.name}** (r${t.round})${statusTag}: ${snippet}`);
  }

  lines.push("");
  lines.push(
    locale === "ja"
      ? "続きが必要なら「続き」「kb を有効化して検索」など具体的に指示してください。"
      : "Ask to continue with a concrete next step if more work is needed.",
  );

  return lines.join("\n");
}
