/**
 * Policy for streaming assistant content during tool-use rounds.
 *
 * Problem: models (esp. GLM) often narrate "I checked / confirmed X" in the
 * same completion as tool_calls. If that prose is streamed to the user and
 * accumulated into the saved answer, it looks like grounded fact even when
 * tool results later contradict it — and the next model round stores
 * content:null for the tool message, so only the user saw the lie.
 *
 * Rule: when tools are offered this round, buffer content until the stream
 * ends. Emit only if there were no tool_calls (final answer in a tools-offered
 * round). Discard intermediate narration when tool_calls occurred.
 */

/** System reminder injected after tool results so the next completion is grounded. */
export const TOOL_GROUNDING_REMINDER =
  "TOOL RESULT GROUNDING (mandatory): Base any claims about files, fields, paths, " +
  "JSON keys, or contents ONLY on tool outputs above. " +
  "If a tool returned [SEARCH empty], [GREP empty], [LIST empty], an error, or a field " +
  "was absent, say so explicitly. " +
  "Do NOT invent schema fields or claim you confirmed something that was not present " +
  "in tool output. Prefer short quotes from tool results when stating facts.";

/**
 * Decide what user-visible content to emit after a streamed completion ends.
 *
 * @returns text to emit via onDelta, or null if nothing should be shown
 *   (already streamed live, or discarded tool-round narration).
 */
export function resolveBufferedToolRoundContent(args: {
  /** Whether tools were offered on this completion request. */
  toolsOffered: boolean;
  /** Whether the completion included any tool_calls. */
  hadToolCalls: boolean;
  /** Content accumulated while tools were offered (not yet shown). */
  bufferedContent: string;
}): string | null {
  if (!args.toolsOffered) {
    // Live-streamed already; nothing to flush.
    return null;
  }
  if (args.hadToolCalls) {
    // Intermediate narration must not become the user-facing answer.
    return null;
  }
  const text = args.bufferedContent;
  return text.length > 0 ? text : null;
}

