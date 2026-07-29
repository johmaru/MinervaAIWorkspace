# Agent Harness Quality Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.  
> **Spec:** [2026-07-29-agent-harness-quality-design.md](../specs/2026-07-29-agent-harness-quality-design.md)  
> **Status:** Ready for implementation (separate model)  
> **Created:** 2026-07-29  
> **Approach:** Self-harness only — **do not** add `@oh-my-pi/*`, `omp` binary, or RPC sidecar.

**Goal:** Make the existing chat tool loop feel more reliable and “agent-like”: structured tool outcomes with next-hints, stronger continue-until-done policy, `edit_file` partial edits, and exploration anti-loop guards — without embedding oh-my-pi.

**Architecture:** Keep `streamCompletion` in `src/app/api/chat/route.ts` as orchestrator. Extract pure policy into `toolOutcome`, `editFile`, `toolLoopGuard`, and extend `agentContinuePolicy` / `agentHooks`. Built-in tool results become `ToolOutcome` → formatted string for the model.

**Tech Stack:** TypeScript, Next.js App Router, Vitest 4, existing workspace helpers, OpenAI-compatible streaming. Prefer **no new npm dependencies**.

---

## Global Constraints

| Constraint | Source |
|------------|--------|
| No OMP / oh-my-pi packages or subprocess | Spec decision |
| Co-located `*.test.ts`; `// @vitest-environment node` for `src/lib/**` and API tests | AGENTS.md |
| `bun run test` + `bun run typecheck` green before claiming done | AGENTS.md |
| Do not break SSE protocol or `after()` memory generation placement | umanschat-debug skill |
| Preserve rapid mode (no tools) and Path A (no function calling) | Spec D modes |
| `write_file` remains; `edit_file` is additive | Spec D3 |
| Exact-match edit only in Phase 1 (no hashline) | Spec D3 |
| i18n: add ja then en for any new status strings | AGENTS.md |
| 1 logical task ≈ 1 commit preferred; English commit messages | project workflow |
| Public product: keep core tools schema-agnostic | AGENTS.md |

### Environment variables (implement these names)

| Variable | Default | Meaning |
|----------|---------|---------|
| `AGENT_CONTINUE_RETRIES` | `3` | Existing; max continue re-entries |
| `AGENT_CONTINUE_MIN_CHARS` | `80` | C2 threshold (extract from hardcode if present) |
| `AGENT_EMPTY_EXPLORATION_LIMIT` | `3` | G2 empty exploration streak |
| `AGENT_EDIT_FUZZY` | `false` | Leave wired false / unused unless Phase 1.5 |

---

## File Structure

**Create**

- `src/lib/toolOutcome.ts` — `ToolOutcome`, factories, `formatToolOutcomeForModel`
- `src/lib/toolOutcome.test.ts`
- `src/lib/editFile.ts` — pure apply + workspace I/O wrapper
- `src/lib/editFile.test.ts`
- `src/lib/toolLoopGuard.ts` — G1–G3 state machine
- `src/lib/toolLoopGuard.test.ts`

**Modify**

- `src/lib/agentContinuePolicy.ts` — C3/C4, optional env min chars, reason codes
- `src/lib/agentContinuePolicy.test.ts`
- `src/lib/agentHooks.ts` — empty/error emphasis in forced/auto report
- `src/lib/agentHooks.test.ts`
- `src/app/api/chat/route.ts` — `edit_file` tool def, outcome formatting, guard, continue args, agent instruction line
- `src/app/api/chat/route.test.ts` — minimal integration coverage
- `src/lib/i18n/dictionaries.ts` — any new status keys (ja + en)
- `docs/tool-calling.md` — align with MAX_TOOL_ROUNDS=12, new tools/policies
- `README.md` / `README.ja.md` — short user-facing note if behavior is user-visible (see readme-update-guide)

**Do not create**

- OMP wrappers, sidecar processes, hashline packages

---

## Task 1: `toolOutcome` pure module

**Files:**
- Create: `src/lib/toolOutcome.ts`
- Create: `src/lib/toolOutcome.test.ts`

**Interfaces:**

```ts
export type ToolOutcomeStatus = "ok" | "empty" | "error" | "blocked" | "partial";

export type ToolOutcome = {
  tool: string;
  status: ToolOutcomeStatus;
  summary: string;
  body: string;
  nextHint?: string;
  code?: string;
};

export function formatToolOutcomeForModel(o: ToolOutcome): string;
export function outcomeOk(tool: string, body: string, summary?: string): ToolOutcome;
export function outcomeEmpty(tool: string, summary: string, nextHint: string, code?: string): ToolOutcome;
export function outcomeError(tool: string, summary: string, nextHint: string, code?: string): ToolOutcome;
export function outcomeBlocked(tool: string, summary: string, nextHint: string, code?: string): ToolOutcome;
```

**Format contract (stable for tests):**

```text
[tool=<name> status=<status> code=<code?>]
summary: <summary>
next: <nextHint if present>
---
<body>
```

- [ ] **Step 1: Write failing tests** for format with/without nextHint, and factories requiring nextHint for empty/error/blocked.

- [ ] **Step 2: Run** `bun run test -- src/lib/toolOutcome.test.ts` — expect FAIL.

- [ ] **Step 3: Implement** `toolOutcome.ts`.

- [ ] **Step 4: Run tests** — expect PASS.

- [ ] **Step 5: Commit**  
  `feat(agent): add structured tool outcome formatter`

---

## Task 2: Wire outcomes into built-in tool dispatch (high-traffic tools first)

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/app/api/chat/route.test.ts` (only if existing tests assert raw strings — update expectations)

**Scope (Phase 1 must cover):**

| Tool | empty / error mapping |
|------|------------------------|
| `read_file` | error + hint to search_files |
| `write_file` | error + hint |
| `list_directory` | empty/error + prefer search_files |
| `search_files` | empty + broaden/narrow pattern hint |
| `grep_content` | empty + hint |
| `run_command` | error + whitelist hint |
| `search_web` / `scrape_webpage` / `search_wikipedia` | empty/error + reformulate hint |
| Remaining built-ins (todo, kb, sandbox, logs, …) | at least error path → `outcomeError`; ok path may wrap `outcomeOk` |

**Rules:**

- Always pass **formatted string** into tool role `content` and `recordToolResult`.
- Keep existing content size caps / slices.
- Do not change MCP/connection formatting unless trivial wrapper.

- [ ] **Step 1: Identify** each `toolContent =` assignment in the dispatch loop.

- [ ] **Step 2: Replace** with `ToolOutcome` + `formatToolOutcomeForModel`.

- [ ] **Step 3: Fix** any route tests that snapshot raw tool strings.

- [ ] **Step 4: Run** `bun run test -- src/app/api/chat/route.test.ts src/lib/toolOutcome.test.ts` and `bun run typecheck`.

- [ ] **Step 5: Commit**  
  `feat(agent): format built-in tool results as structured outcomes`

---

## Task 3: Strengthen `agentContinuePolicy` (C3/C4)

**Files:**
- Modify: `src/lib/agentContinuePolicy.ts`
- Modify: `src/lib/agentContinuePolicy.test.ts`
- Modify: `src/app/api/chat/route.ts` (pass new args + log reason)

**Behavior:**

1. Extract min-chars threshold to `agentContinueMinCharsFromEnv()` (default 80).
2. Add optional args: `lastAssistantText?`, `unfinishedToolWork?`.
3. **C3:** after tools, if last/emitted text matches “I’ll do it / 確認します / 次に調べ” style **without** substance → continue (ja + en regex; keep conservative).
4. **C4:** `unfinishedToolWork && emittedContentChars < 400` → continue.
5. Return or log **reason** (`C1`|`C2`|`C3`|`C4`) — either change return type to `{ continue: boolean; reason?: string }` **or** add `classifyContinueReason(...)` used by route logger. Prefer small pure API:

```ts
export type ContinueDecision = { shouldContinue: boolean; reason?: "C1" | "C2" | "C3" | "C4" };

export function decideContinueToolLoop(args: /* … */): ContinueDecision;
// Keep shouldContinueToolLoop as thin wrapper for back-compat if many call sites/tests.
```

6. `unfinishedToolWork` computation in route: true if any of last ~6 transcript entries contain `status=error` or `status=empty` or `status=blocked` (string includes after format), or failed write/edit names.

- [ ] **Step 1: Tests** for C1–C4, budget exhaustion, no false continue on short chitchat with **no tools**.

- [ ] **Step 2: Implement** policy.

- [ ] **Step 3: Wire** route + logger `reason`.

- [ ] **Step 4: Run tests + typecheck**.

- [ ] **Step 5: Commit**  
  `feat(agent): strengthen continue-until-done policy (C3/C4)`

---

## Task 4: `editFile` pure apply + tool

**Files:**
- Create: `src/lib/editFile.ts`
- Create: `src/lib/editFile.test.ts`
- Modify: `src/app/api/chat/route.ts` — STREAM_TOOLS entry + dispatch
- Modify: agent instruction string (prefer edit_file for existing files)

**Pure API:**

```ts
export type EditFileApplyResult =
  | { ok: true; newContent: string; occurrences: number }
  | { ok: false; code: "EDIT_NO_MATCH" | "EDIT_AMBIGUOUS" | "EDIT_EMPTY_OLD"; message: string };

export function applyEditFile(args: {
  content: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): EditFileApplyResult;
```

**I/O wrapper** (same workspace root rules as `write_file` — reuse existing helpers; do not invent new path escape holes):

```ts
export async function editFileInWorkspace(args: {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  // inject read/write for tests if helpful
}): Promise<ToolOutcome>;
```

**Tool schema:** `path`, `old_string`, `new_string`, `replace_all?` (boolean, default false).

**On success body:** short summary (`updated path; N replacements; size before→after`), not full file.

- [ ] **Step 1: Unit tests** for apply (0, 1, many, replace_all, empty old_string).

- [ ] **Step 2: Implement** pure apply.

- [ ] **Step 3: Workspace integration tests** with temp dir (or mock fs).

- [ ] **Step 4: Register tool + dispatch** → ToolOutcome.

- [ ] **Step 5: Add system line** preferring `edit_file` for existing files.

- [ ] **Step 6: Run tests + typecheck**.

- [ ] **Step 7: Commit**  
  `feat(agent): add edit_file exact str_replace tool`

---

## Task 5: `toolLoopGuard` (G1–G3)

**Files:**
- Create: `src/lib/toolLoopGuard.ts`
- Create: `src/lib/toolLoopGuard.test.ts`
- Modify: `src/app/api/chat/route.ts` — replace inline `seenToolCalls` block with guard

**API sketch:**

```ts
export type LoopGuardState = { /* internal */ };

export function createLoopGuardState(env?: NodeJS.ProcessEnv): LoopGuardState;

/** Call before execute for signature duplicates (G1). */
export function precheckToolCalls(
  state: LoopGuardState,
  calls: { name: string; arguments: string }[],
): { blocked: boolean; results?: ToolOutcome[] };

/** Call after each outcome for empty-exploration streak (G2/G3). */
export function recordToolOutcome(
  state: LoopGuardState,
  call: { name: string; arguments: string },
  outcome: ToolOutcome,
): { softBlockNext?: ToolOutcome }; // optional advisory
```

**G1:** Same as today — if any call signature count > `MAX_DUPLICATE_CALLS` (2 allowed, block 3rd), block **entire round** with blocked outcomes + one round tools-off (preserve current UX).

**G2:** Track consecutive `empty` among exploration tools: `list_directory`, `search_files`, `grep_content`, `search_web`, `search_wikipedia`. On limit → inject blocked system or force next tools-off round with clear nextHint.

**G3:** Same path `list_directory` ≥ 3 times in turn regardless of depth arg → block further list on that path.

Preserve SSE status for loop detected (existing i18n key).

- [ ] **Step 1: Tests** for G1/G2/G3 transitions and reset per `createLoopGuardState`.

- [ ] **Step 2: Implement** module.

- [ ] **Step 3: Replace** route inline loop detection; ensure `formatToolOutcomeForModel` used for blocked messages.

- [ ] **Step 4: Run tests + typecheck**.

- [ ] **Step 5: Commit**  
  `feat(agent): add exploration anti-loop guard`

---

## Task 6: Hooks prompt polish + agent instruction pass

**Files:**
- Modify: `src/lib/agentHooks.ts` + test
- Modify: `src/app/api/chat/route.ts` agent/tool system strings (minimal)

**Changes:**

- Forced report: explicitly list tools with `status=error|empty|blocked` and forbid inventing success.
- Auto-report: show status token if present in transcript lines.
- Agent instructions (short bullets only): edit_file preference; obey next hints; no list_directory spam; final answer in content.

- [ ] **Step 1: Tests** for forced prompt containing grounding language for failed tools.

- [ ] **Step 2: Implement**.

- [ ] **Step 3: Run** relevant unit tests.

- [ ] **Step 4: Commit**  
  `feat(agent): tighten post-tool report hooks and agent instructions`

---

## Task 7: Docs + README parity

**Files:**
- Modify: `docs/tool-calling.md` (fix Path B max rounds 3 → 12 if still wrong; document edit_file, outcomes, continue, guard)
- Modify: `README.md` + `README.ja.md` only if user-visible behavior is described in feature lists — keep dual-file parity (readme-update-guide)
- Optional: one paragraph in `docs/chat-streaming.md` about agent-continue status

- [ ] **Step 1: Update tool-calling.md** to match code.

- [ ] **Step 2: README check** — do not claim OMP integration.

- [ ] **Step 3: Commit**  
  `docs(agent): document harness quality (outcomes, edit_file, continue)`

---

## Task 8: Full verification gate

- [ ] **Step 1: Run** `bun run test`

- [ ] **Step 2: Run** `bun run typecheck`

- [ ] **Step 3: Manual smoke (if env available):**  
  - Ask multi-step workspace task → should continue or tool instead of thinking-only end  
  - `edit_file` with wrong old_string → error outcome, file unchanged  
  - Repeat same search empty → guard trips  

- [ ] **Step 4: Work-completion checklist** — no orphan untracked files; push only if user asked

- [ ] **Step 5: Final commit** only if fixes needed from verification  
  `fix(agent): harness quality verification fixes`

---

## Out of scope (do not implement in this plan)

- `@oh-my-pi/*`, `omp` RPC/SDK embed
- hashline edit format
- LSP/DAP/browser/subagents/advisor
- Settings UI for agent env vars
- Full `dispatchBuiltInTool` extraction of entire route switch (optional follow-up PR)
- Changing rapid mode or dual orchestration structure

---

## Suggested PR / commit sequence

1. Task 1 — toolOutcome  
2. Task 2 — wire outcomes  
3. Task 3 — continue  
4. Task 4 — edit_file  
5. Task 5 — loop guard  
6. Task 6 — hooks/instructions  
7. Task 7 — docs  
8. Task 8 — verify  

If a single PR is required: same order in one branch, keep commits atomic.

---

## Implementation notes for the coding agent

1. **Read first:** Spec + `agentContinuePolicy.ts` + `agentHooks.ts` + `toolStreamPolicy.ts` + the `streamCompletion` loop section of `route.ts` (continue, loop detect, tool dispatch, forced report).
2. **Do not** move `after()` for memories inside `ReadableStream.start`.
3. **Workspace path safety:** copy patterns from existing `read_file` / `write_file` handlers; never open paths outside workspace.
4. **Tests:** prefer pure unit tests; avoid over-mocking the entire chat route unless necessary.
5. **If stuck on route size:** complete outcome formatting for workspace tools + edit_file + guard first; defer pretty-wrapping every todo/kb success body.
6. **Success = Spec S1–S6.**
