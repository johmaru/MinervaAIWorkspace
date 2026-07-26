/**
 * Agent continue policy — OMP-style "keep going until the task is done".
 *
 * UmansChat historically exited the tool loop as soon as a completion emitted
 * **no tool_calls**, even when:
 * - the model only produced thinking (no user-visible answer), or
 * - tools already ran but the multi-step job is obviously unfinished.
 *
 * Coding agents (OMP / Claude Code / etc.) instead re-prompt and keep tool
 * access until a real answer appears or a hard budget is exhausted.
 */

import type { ToolTranscriptEntry } from "@/lib/agentHooks";
import { hasUserVisibleContent } from "@/lib/agentHooks";

/** Default: how many times we may re-enter the loop after a premature stop. */
export const DEFAULT_AGENT_CONTINUE_RETRIES = 3;

export function agentContinueRetriesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.AGENT_CONTINUE_RETRIES);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_AGENT_CONTINUE_RETRIES;
  return Math.min(8, Math.floor(raw));
}

/**
 * True when this completion stopped without tool_calls but the agent should
 * still keep tools and try another round (instead of breaking the loop).
 */
export function shouldContinueToolLoop(args: {
  hadToolCalls: boolean;
  toolsWereOffered: boolean;
  emittedContentChars: number;
  toolRounds: number;
  toolResultCount: number;
  continueRetriesUsed: number;
  maxContinueRetries: number;
  /** Hard tool-round budget (MAX_TOOL_ROUNDS). */
  maxToolRounds: number;
}): boolean {
  if (args.hadToolCalls) return false;
  if (!args.toolsWereOffered) return false;
  if (args.continueRetriesUsed >= args.maxContinueRetries) return false;
  if (args.toolRounds >= args.maxToolRounds) return false;

  // Case A: pure thinking / silence — never finished, never answered.
  if (!hasUserVisibleContent(args.emittedContentChars)) {
    return true;
  }

  // Case B: short "ok I'll do it" style content after tools, without a real report.
  // Leave alone if no tools ran (normal short chat).
  if (args.toolResultCount > 0 && args.emittedContentChars < 80) {
    return true;
  }

  return false;
}

/**
 * System nudge injected when we re-enter the loop. Tools stay available.
 */
export function buildContinueAgentPrompt(args: {
  toolTranscript: ToolTranscriptEntry[];
  continueRetriesUsed: number;
  maxContinueRetries: number;
}): string {
  const left = args.maxContinueRetries - args.continueRetriesUsed;
  const header =
    "AGENT CONTINUE HOOK (mandatory — do not stop mid-task):\n" +
    "You stopped without completing the user's request and/or without a full user-visible answer.\n" +
    "Call the NEXT needed tool NOW (write_file, sandbox_run, kb_from_jsonl, kb_ingest_jsonl, kb_search, …).\n" +
    "Do NOT only think/plan. Do NOT re-explore the same paths.\n" +
    `Continue budget remaining after this re-entry: ${Math.max(0, left - 1)}.\n` +
    "When the work is truly done, write a concrete report in message CONTENT (paths, kb_id, counts, errors).";

  if (args.toolTranscript.length === 0) {
    return (
      header +
      "\n\nNo tools have run yet this turn. Start with the first concrete tool call."
    );
  }

  const recent = args.toolTranscript.slice(-6);
  const body = recent
    .map(
      (t, i) =>
        `### Done ${i + 1}: ${t.name} (round ${t.round})\n${t.content.slice(0, 800)}`,
    )
    .join("\n\n");

  return `${header}\n\n## Tools already run (build on these — do not redo blindly)\n\n${body}`;
}
