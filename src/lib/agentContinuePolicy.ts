/**
 * Agent continue policy — OMP-style "keep going until the task is done".
 *
 * MinervaAIWorkspace historically exited the tool loop as soon as a completion emitted
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

/** Default C2 threshold: minimum chars to consider content a real answer after tools. */
export const DEFAULT_AGENT_CONTINUE_MIN_CHARS = 80;

/** C4 threshold: if unfinished tool work and content is shorter than this, continue. */
const C4_MAX_CHARS = 400;

export function agentContinueRetriesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.AGENT_CONTINUE_RETRIES);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_AGENT_CONTINUE_RETRIES;
  return Math.min(8, Math.floor(raw));
}

export function agentContinueMinCharsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.AGENT_CONTINUE_MIN_CHARS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_AGENT_CONTINUE_MIN_CHARS;
  return Math.floor(raw);
}

/**
 * ja + en "promise-only" patterns: content that announces intent without
 * doing the work. Conservative — only matches clearly preliminary phrasing.
 */
const PROMISE_ONLY_PATTERNS: RegExp[] = [
  /(?:^|[\s。])I[''']ll (?:check|look|verify|do|try|search|read|write|create|update|run)\b/i,
  /(?:^|[\s。])Let me (?:check|look|verify|search|read|find|try|see)\b/i,
  /(?:^|[\s。])I will (?:check|look|verify|do|search|read|write|create|run)\b/i,
  /次に.*(?:調べ|確認|行|実行|見)ます/,
  /(?:を|が|で|に|は|の|も)?確認します/,
  /やってみます/,
  /探してみます/,
  /見てみます/,
  /実行します/,
];

/** True if the text is only a preliminary announcement without substance. */
function isPromiseOnlyText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Must be short (a real report is usually longer than a one-liner promise).
  if (trimmed.length > 200) return false;
  return PROMISE_ONLY_PATTERNS.some((re) => re.test(trimmed));
}

export type ContinueReason = "C1" | "C2" | "C3" | "C4";

export type ContinueDecision = { shouldContinue: boolean; reason?: ContinueReason };

/**
 * Decide whether to re-enter the tool loop after a premature stop.
 * Returns a decision with a reason code:
 * - C1: pure thinking / silence (no visible content)
 * - C2: tools ran + content shorter than min-chars threshold
 * - C3: tools ran + content is only a preliminary "I'll do it" announcement
 * - C4: unfinished tool work (error/empty outcomes) + content shorter than C4 threshold
 */
export function decideContinueToolLoop(args: {
  hadToolCalls: boolean;
  toolsWereOffered: boolean;
  emittedContentChars: number;
  toolRounds: number;
  toolResultCount: number;
  continueRetriesUsed: number;
  maxContinueRetries: number;
  /** Hard tool-round budget (MAX_TOOL_ROUNDS). */
  maxToolRounds: number;
  /** C2 threshold from env (default 80). */
  minChars?: number;
  /** Last assistant content buffer this round (for C3 promise detection). */
  lastAssistantText?: string;
  /** Whether transcript suggests unfinished multi-step work (error/empty outcomes). */
  unfinishedToolWork?: boolean;
}): ContinueDecision {
  if (args.hadToolCalls) return { shouldContinue: false };
  if (!args.toolsWereOffered) return { shouldContinue: false };
  if (args.continueRetriesUsed >= args.maxContinueRetries) return { shouldContinue: false };
  if (args.toolRounds >= args.maxToolRounds) return { shouldContinue: false };

  const minChars = args.minChars ?? DEFAULT_AGENT_CONTINUE_MIN_CHARS;

  // C1: pure thinking / silence — never finished, never answered.
  if (!hasUserVisibleContent(args.emittedContentChars)) {
    return { shouldContinue: true, reason: "C1" };
  }

  // C2: short "ok I'll do it" style content after tools, without a real report.
  // Leave alone if no tools ran (normal short chat).
  if (args.toolResultCount > 0 && args.emittedContentChars < minChars) {
    return { shouldContinue: true, reason: "C2" };
  }

  // C3: tools ran + content is only a preliminary announcement (ja + en).
  if (args.toolResultCount > 0 && args.lastAssistantText && isPromiseOnlyText(args.lastAssistantText)) {
    return { shouldContinue: true, reason: "C3" };
  }

  // C4: unfinished tool work (error/empty outcomes) + still-short content.
  if (args.unfinishedToolWork && args.emittedContentChars < C4_MAX_CHARS) {
    return { shouldContinue: true, reason: "C4" };
  }

  return { shouldContinue: false };
}

/**
 * Backward-compatible wrapper: returns only the boolean.
 * Prefer `decideContinueToolLoop` when the reason is needed.
 */
export function shouldContinueToolLoop(args: {
  hadToolCalls: boolean;
  toolsWereOffered: boolean;
  emittedContentChars: number;
  toolRounds: number;
  toolResultCount: number;
  continueRetriesUsed: number;
  maxContinueRetries: number;
  maxToolRounds: number;
  minChars?: number;
  lastAssistantText?: string;
  unfinishedToolWork?: boolean;
}): boolean {
  return decideContinueToolLoop(args).shouldContinue;
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

