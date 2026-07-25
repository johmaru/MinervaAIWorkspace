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
 * Forced when the model finishes tool rounds (or the whole turn) with only
 * reasoning_content and zero user-visible content — common with high-thinking
 * GLM when intermediate prose was discarded.
 */
export const FINAL_ANSWER_REQUIRED_REMINDER =
  "FINAL ANSWER REQUIRED: You produced no user-visible message content. " +
  "The user cannot read your thinking block as the answer. " +
  "Write the complete reply NOW in the assistant message content (not only in thinking). " +
  "Do not call tools. Base claims on tool results already in this conversation. " +
  "If the task is multi-step and incomplete, report: (1) what you confirmed, (2) files written " +
  "or KB actions taken, (3) what is still missing, (4) the next concrete step. " +
  "Never invent JSON fields or file contents that tools did not return.";

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

/** Whether to run one tools-off recovery completion after the main loop. */
export function shouldForceFinalAnswer(args: {
  /** Characters already emitted to the user via onDelta. */
  emittedContentChars: number;
  /** True if at least one tool round ran (rounds > 0) or we still have empty content. */
  forceWhenEmpty: boolean;
}): boolean {
  return args.forceWhenEmpty && args.emittedContentChars === 0;
}
