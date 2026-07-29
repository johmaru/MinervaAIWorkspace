// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createLoopGuardState,
  precheckToolCalls,
  recordToolOutcome,
  type LoopGuardState,
} from "./toolLoopGuard";
import { outcomeOk, outcomeEmpty, outcomeBlocked } from "@/lib/toolOutcome";

function makeCall(name: string, args: string) {
  return { name, arguments: args };
}

describe("toolLoopGuard — G1: duplicate signature detection", () => {
  it("allows first two identical calls, blocks the third", () => {
    const state = createLoopGuardState();
    const call = makeCall("search_files", '{"pattern":"*.ts"}');

    // 1st: allow
    const r1 = precheckToolCalls(state, [call]);
    expect(r1.blocked).toBe(false);

    // 2nd: allow
    const r2 = precheckToolCalls(state, [call]);
    expect(r2.blocked).toBe(false);

    // 3rd: block
    const r3 = precheckToolCalls(state, [call]);
    expect(r3.blocked).toBe(true);
    expect(r3.results).toBeDefined();
    expect(r3.results!.length).toBe(1);
    expect(r3.results![0]!.status).toBe("blocked");
  });

  it("blocks entire round when any call is a duplicate", () => {
    const state = createLoopGuardState();
    const dup = makeCall("list_directory", '{"path":"."}');
    const unique = makeCall("read_file", '{"path":"a.ts"}');

    // Run the dup twice first
    precheckToolCalls(state, [dup]);
    precheckToolCalls(state, [dup]);

    // 3rd round with both
    const r = precheckToolCalls(state, [dup, unique]);
    expect(r.blocked).toBe(true);
    expect(r.results!.length).toBe(2);
    // Both get blocked outcomes
    expect(r.results!.every((o) => o.status === "blocked")).toBe(true);
  });

  it("does not block different calls with same tool name", () => {
    const state = createLoopGuardState();
    precheckToolCalls(state, [makeCall("search_files", '{"pattern":"*.ts"}')]);
    precheckToolCalls(state, [makeCall("search_files", '{"pattern":"*.ts"}')]);
    // Different args → not a duplicate
    const r = precheckToolCalls(state, [makeCall("search_files", '{"pattern":"*.tsx"}')]);
    expect(r.blocked).toBe(false);
  });
});

describe("toolLoopGuard — G2: empty exploration streak", () => {
  it("blocks after 3 consecutive empty exploration results", () => {
    const state = createLoopGuardState();

    // Use different args each call to avoid G1 duplicate detection
    const call1 = makeCall("search_files", '{"pattern":"*.xyz"}');
    const call2 = makeCall("search_files", '{"pattern":"*.abc"}');
    const call3 = makeCall("search_files", '{"pattern":"*.def"}');

    // First two empties: record outcomes
    precheckToolCalls(state, [call1]);
    recordToolOutcome(state, call1, outcomeEmpty("search_files", "empty", "try again"));

    precheckToolCalls(state, [call2]);
    recordToolOutcome(state, call2, outcomeEmpty("search_files", "empty", "try again"));

    // Third precheck should block (streak hit limit)
    const r = precheckToolCalls(state, [call3]);
    expect(r.blocked).toBe(true);
    expect(r.results![0]!.status).toBe("blocked");
  });

  it("resets empty streak on a non-empty result", () => {
    const state = createLoopGuardState();
    const call1 = makeCall("search_files", '{"pattern":"*.xyz"}');
    const call2 = makeCall("search_files", '{"pattern":"*.abc"}');
    const call3 = makeCall("search_files", '{"pattern":"*.def"}');

    precheckToolCalls(state, [call1]);
    recordToolOutcome(state, call1, outcomeEmpty("search_files", "empty", "try again"));

    precheckToolCalls(state, [call2]);
    // Non-empty result resets streak
    recordToolOutcome(state, call2, outcomeOk("search_files", "found 3 files"));

    // Should not block now
    const r = precheckToolCalls(state, [call3]);
    expect(r.blocked).toBe(false);
  });

  it("does not count non-exploration tools toward G2 streak", () => {
    const state = createLoopGuardState();
    const call = makeCall("write_file", '{"path":"a.ts","content":"x"}');

    precheckToolCalls(state, [call]);
    recordToolOutcome(state, call, outcomeOk("write_file", "written"));

    precheckToolCalls(state, [call]);
    recordToolOutcome(state, call, outcomeOk("write_file", "written"));

    // 3rd write_file is a G1 duplicate, not G2
    const r = precheckToolCalls(state, [call]);
    expect(r.blocked).toBe(true); // G1 blocks it
    expect(r.results![0]!.code).toBe("LOOP_G1");
  });
});

describe("toolLoopGuard — G3: same path list_directory spam", () => {
  it("blocks list_directory on same path after 3 calls regardless of depth", () => {
    const state = createLoopGuardState();

    const call1 = makeCall("list_directory", '{"path":".","depth":1}');
    precheckToolCalls(state, [call1]);
    recordToolOutcome(state, call1, outcomeOk("list_directory", "[FILE] a.ts"));

    const call2 = makeCall("list_directory", '{"path":".","depth":2}');
    precheckToolCalls(state, [call2]);
    recordToolOutcome(state, call2, outcomeOk("list_directory", "[FILE] a.ts\n[DIR] src"));

    const call3 = makeCall("list_directory", '{"path":".","depth":3}');
    const r = precheckToolCalls(state, [call3]);
    expect(r.blocked).toBe(true);
    expect(r.results![0]!.code).toBe("LOOP_G3");
  });

  it("does not block list_directory on different paths", () => {
    const state = createLoopGuardState();

    const c1 = makeCall("list_directory", '{"path":"."}');
    precheckToolCalls(state, [c1]);
    recordToolOutcome(state, c1, outcomeOk("list_directory", "ok"));

    const c2 = makeCall("list_directory", '{"path":"src"}');
    precheckToolCalls(state, [c2]);
    recordToolOutcome(state, c2, outcomeOk("list_directory", "ok"));

    const c3 = makeCall("list_directory", '{"path":"docs"}');
    const r = precheckToolCalls(state, [c3]);
    expect(r.blocked).toBe(false);
  });
});

describe("toolLoopGuard — state isolation", () => {
  it("fresh state has no memory of previous state", () => {
    const s1 = createLoopGuardState();
    const call = makeCall("search_files", '{"pattern":"*.ts"}');
    precheckToolCalls(s1, [call]);
    precheckToolCalls(s1, [call]);

    const s2 = createLoopGuardState();
    const r = precheckToolCalls(s2, [call]);
    expect(r.blocked).toBe(false);
  });
});
