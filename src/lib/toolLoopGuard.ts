/**
 * Exploration anti-loop guard for the tool-use loop.
 *
 * Replaces the inline `seenToolCalls` duplicate detection in route.ts with a
 * structured state machine that catches:
 *
 * - G1: same tool+args signature called more than MAX_DUPLICATE_CALLS times
 * - G2: consecutive empty results from exploration tools (list_directory,
 *       search_files, grep_content, search_web, search_wikipedia)
 * - G3: same list_directory path called 3+ times (regardless of depth arg)
 *
 * State is per-turn (created at the start of each streamCompletion call).
 */

import {
  outcomeBlocked,
  type ToolOutcome,
} from "@/lib/toolOutcome";

/** Max identical (tool+args) calls before blocking (allow 2, block 3rd). */
const MAX_DUPLICATE_CALLS = 2;

/** Consecutive empty exploration results before blocking. */
const DEFAULT_EMPTY_EXPLORATION_LIMIT = 3;
/** list_directory calls on the same path before blocking. */
const MAX_SAME_PATH_LIST = 3;

/** Exploration tools whose empty results count toward G2. */
const EXPLORATION_TOOLS: Record<string, boolean> = {
  list_directory: true,
  search_files: true,
  grep_content: true,
  search_web: true,
  search_wikipedia: true,
};

export type LoopGuardState = {
  /** signature → count, for G1 duplicate detection. */
  signatures: Record<string, number>;
  /** consecutive empty exploration result count, for G2. */
  emptyExplorationStreak: number;
  /** list_directory path → count, for G3. */
  listDirPathCounts: Record<string, number>;
  /** configurable empty exploration limit. */
  emptyExplorationLimit: number;
};

export function createLoopGuardState(
  env: NodeJS.ProcessEnv = process.env,
): LoopGuardState {
  const raw = Number(env.AGENT_EMPTY_EXPLORATION_LIMIT);
  const limit =
    Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : DEFAULT_EMPTY_EXPLORATION_LIMIT;
  return {
    signatures: {},
    emptyExplorationStreak: 0,
    listDirPathCounts: {},
    emptyExplorationLimit: limit,
  };
}

/** Extract the path argument from a tool call's arguments JSON. */
function extractPath(argumentsJson: string): string | null {
  try {
    const parsed = JSON.parse(argumentsJson) as { path?: string };
    return parsed.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Pre-check tool calls before execution. Returns blocked=true if any call
 * triggers G1 (duplicate) or G3 (same-path list spam). When blocked, returns
 * blocked ToolOutcomes for ALL calls in the round (matching existing UX of
 * blocking the entire round + one tools-off round).
 */
export function precheckToolCalls(
  state: LoopGuardState,
  calls: { name: string; arguments: string }[],
): { blocked: boolean; results?: ToolOutcome[] } {
  // G1: check for duplicate signatures
  let g1Blocked = false;
  for (const call of calls) {
    const sig = `${call.name}:${call.arguments}`;
    state.signatures[sig] = (state.signatures[sig] ?? 0) + 1;
    if (state.signatures[sig] > MAX_DUPLICATE_CALLS) {
      g1Blocked = true;
    }
  }

  // G3: check for same-path list_directory spam
  let g3Blocked = false;
  for (const call of calls) {
    if (call.name === "list_directory") {
      const path = extractPath(call.arguments);
      if (path) {
        state.listDirPathCounts[path] = (state.listDirPathCounts[path] ?? 0) + 1;
        if (state.listDirPathCounts[path] >= MAX_SAME_PATH_LIST) {
          g3Blocked = true;
        }
      }
    }
  }

  // G2: block pre-emptively when the next exploration call would reach the
  // limit. If streak >= limit - 1, this call would be the Nth consecutive empty.
  const g2Blocked = state.emptyExplorationStreak >= state.emptyExplorationLimit - 1;

  if (g1Blocked || g3Blocked || g2Blocked) {
    const results = calls.map((call) => {
      if (g1Blocked) {
        return outcomeBlocked(
          call.name,
          "LOOP DETECTED: You have already called this tool with the same arguments.",
          "Do not repeat the same call. Summarize what you found so far and answer the user.",
          "LOOP_G1",
        );
      }
      if (g3Blocked) {
        return outcomeBlocked(
          call.name,
          `You have listed this directory ${MAX_SAME_PATH_LIST}+ times.`,
          "Stop listing this directory. Use search_files or grep_content instead.",
          "LOOP_G3",
        );
      }
      // g2Blocked
      return outcomeBlocked(
        call.name,
        `Empty exploration streak limit reached (${state.emptyExplorationStreak} consecutive empty results).`,
        "Change your search strategy. Try different keywords, a broader pattern, or ask the user for guidance.",
        "LOOP_G2",
      );
    });
    // Reset streak after blocking to allow a fresh approach next round
    state.emptyExplorationStreak = 0;
    return { blocked: true, results };
  }

  return { blocked: false };
}

/**
 * Record a tool outcome after execution. Updates the G2 empty streak counter.
 * Returns an optional advisory soft-block if the streak is approaching the limit.
 */
export function recordToolOutcome(
  state: LoopGuardState,
  call: { name: string; arguments: string },
  outcome: ToolOutcome,
): { softBlockNext?: ToolOutcome } {
  if (EXPLORATION_TOOLS[call.name]) {
    if (outcome.status === "empty") {
      state.emptyExplorationStreak++;
    } else {
      state.emptyExplorationStreak = 0;
    }
  }
  return {};
}
