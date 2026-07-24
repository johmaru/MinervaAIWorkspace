// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EVOLUTION_DEFAULTS,
  shouldProposeEvolution,
  measureContentDelta,
  isBoundedEdit,
} from "@/lib/skillEvolution";

describe("measureContentDelta — golden fixtures", () => {
  it("identity: same string → absChanged=0", () => {
    const { absChanged, fracChanged, lcp, lcs } = measureContentDelta("abc", "abc");
    expect(absChanged).toBe(0);
    expect(fracChanged).toBe(0);
    expect(lcp).toBe(3);
    expect(lcs).toBe(0); // no suffix beyond prefix
  });

  it("small bullet tweak: bounded true", () => {
    const prev = "1. Do A\n2. Do B\n3. Do C";
    const next = "1. Do A\n2. Do B carefully\n3. Do C";
    const { absChanged } = measureContentDelta(prev, next);
    expect(absChanged).toBeLessThan(20);
    expect(isBoundedEdit(prev, next)).toBe(true);
  });

  it("full rewrite: bounded false", () => {
    // prev must be long enough that cap = max(500, floor(len*0.35)) < absChanged
    // Use 1000-char prev, 1000-char completely different next:
    // cap = max(500, 350) = 500, absChanged = 1000 → 1000 > 500 → bounded false
    const prev = "x".repeat(1000);
    const next = "y".repeat(1000);
    expect(isBoundedEdit(prev, next)).toBe(false);
  });

  it("empty next: bounded false", () => {
    expect(isBoundedEdit("hello", "")).toBe(false);
    expect(isBoundedEdit("hello", "   ")).toBe(false);
  });

  it("unicode: handles Japanese code units", () => {
    const prev = "日本語スキル手順";
    const next = "日本語スキル手順を明確化";
    const { absChanged, lcp } = measureContentDelta(prev, next);
    expect(lcp).toBe(prev.length); // prev is a prefix of next
    expect(absChanged).toBe(next.length - prev.length);
    expect(isBoundedEdit(prev, next)).toBe(true);
  });
});

describe("isBoundedEdit — boundary cases", () => {
  it("respects maxAbsCharsChanged for short strings", () => {
    const prev = "ab";
    const next = "abcd";
    // absChanged = 2, cap = max(500, floor(2 * 0.35)) = max(500, 0) = 500
    expect(isBoundedEdit(prev, next)).toBe(true);
  });

  it("rejects when absChanged exceeds cap", () => {
    const prev = "x".repeat(1000);
    const next = "y".repeat(1000); // completely different
    // absChanged = 1000, cap = max(500, floor(1000 * 0.35)) = max(500, 350) = 500
    expect(isBoundedEdit(prev, next)).toBe(false);
  });

  it("allows when absChanged equals cap", () => {
    const prev = "x".repeat(1000);
    // Change exactly 500 chars (cap = 500)
    const next = "y".repeat(500) + "x".repeat(500);
    const { absChanged } = measureContentDelta(prev, next);
    // lcp=0, lcs=500 (the trailing 500 x's match), absChanged = |1000-1000| + (1000-0-500) = 500
    expect(absChanged).toBe(500);
    expect(isBoundedEdit(prev, next)).toBe(true);
  });
});

describe("shouldProposeEvolution", () => {
  it("returns false when open draft exists", () => {
    expect(shouldProposeEvolution({ windowSuccess: 0, windowFailure: 10, hasOpenDraft: true, cooldownActive: false })).toBe(false);
  });

  it("returns false when cooldown active", () => {
    expect(shouldProposeEvolution({ windowSuccess: 0, windowFailure: 10, hasOpenDraft: false, cooldownActive: true })).toBe(false);
  });

  it("returns true when net failures >= minNetFailures", () => {
    expect(shouldProposeEvolution({ windowSuccess: 0, windowFailure: 3, hasOpenDraft: false, cooldownActive: false })).toBe(true);
  });

  it("returns true when failure rate >= maxFailureRate and samples >= minSamples", () => {
    // 3 failures / 5 samples = 0.6 >= 0.5
    expect(shouldProposeEvolution({ windowSuccess: 2, windowFailure: 3, hasOpenDraft: false, cooldownActive: false })).toBe(true);
  });

  it("returns false when samples < minSamples and net < minNetFailures", () => {
    expect(shouldProposeEvolution({ windowSuccess: 0, windowFailure: 1, hasOpenDraft: false, cooldownActive: false })).toBe(false);
  });

  it("returns false when all helpful", () => {
    expect(shouldProposeEvolution({ windowSuccess: 10, windowFailure: 0, hasOpenDraft: false, cooldownActive: false })).toBe(false);
  });
});

describe("EVOLUTION_DEFAULTS", () => {
  it("has expected configuration values", () => {
    expect(EVOLUTION_DEFAULTS.minNetFailures).toBe(3);
    expect(EVOLUTION_DEFAULTS.minSamples).toBe(5);
    expect(EVOLUTION_DEFAULTS.maxFailureRate).toBe(0.5);
    expect(EVOLUTION_DEFAULTS.cooldownMs).toBe(60 * 60 * 1000);
    expect(EVOLUTION_DEFAULTS.forceMinIntervalMs).toBe(5 * 60 * 1000);
  });
});
