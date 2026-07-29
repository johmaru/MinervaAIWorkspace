// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  agentContinueRetriesFromEnv,
  agentContinueMinCharsFromEnv,
  shouldContinueToolLoop,
  decideContinueToolLoop,
  buildContinueAgentPrompt,
} from "./agentContinuePolicy";

describe("agentContinuePolicy", () => {
  it("continues when tools were offered but model only thought (no tools, no body)", () => {
    expect(
      shouldContinueToolLoop({
        hadToolCalls: false,
        toolsWereOffered: true,
        emittedContentChars: 0,
        toolRounds: 0,
        toolResultCount: 0,
        continueRetriesUsed: 0,
        maxContinueRetries: 3,
        maxToolRounds: 12,
      }),
    ).toBe(true);
  });

  it("continues after partial tools with still-empty body", () => {
    expect(
      shouldContinueToolLoop({
        hadToolCalls: false,
        toolsWereOffered: true,
        emittedContentChars: 0,
        toolRounds: 2,
        toolResultCount: 3,
        continueRetriesUsed: 1,
        maxContinueRetries: 3,
        maxToolRounds: 12,
      }),
    ).toBe(true);
  });

  it("does not continue when a real answer already exists and no short-after-tools", () => {
    expect(
      shouldContinueToolLoop({
        hadToolCalls: false,
        toolsWereOffered: true,
        emittedContentChars: 200,
        toolRounds: 1,
        toolResultCount: 1,
        continueRetriesUsed: 0,
        maxContinueRetries: 3,
        maxToolRounds: 12,
      }),
    ).toBe(false);
  });

  it("does not continue when tool_calls are present (normal tool path)", () => {
    expect(
      shouldContinueToolLoop({
        hadToolCalls: true,
        toolsWereOffered: true,
        emittedContentChars: 0,
        toolRounds: 0,
        toolResultCount: 0,
        continueRetriesUsed: 0,
        maxContinueRetries: 3,
        maxToolRounds: 12,
      }),
    ).toBe(false);
  });

  it("respects continue retry budget", () => {
    expect(
      shouldContinueToolLoop({
        hadToolCalls: false,
        toolsWereOffered: true,
        emittedContentChars: 0,
        toolRounds: 1,
        toolResultCount: 0,
        continueRetriesUsed: 3,
        maxContinueRetries: 3,
        maxToolRounds: 12,
      }),
    ).toBe(false);
  });

  it("parses env and builds continue prompt", () => {
    expect(agentContinueRetriesFromEnv({ AGENT_CONTINUE_RETRIES: "5" } as NodeJS.ProcessEnv)).toBe(5);
    expect(agentContinueRetriesFromEnv({} as NodeJS.ProcessEnv)).toBe(3);
    const prompt = buildContinueAgentPrompt({
      toolTranscript: [{ name: "kb_list", content: "[]", round: 1 }],
      continueRetriesUsed: 0,
      maxContinueRetries: 3,
    });
    expect(prompt).toMatch(/AGENT CONTINUE HOOK/);
    expect(prompt).toMatch(/kb_list/);
  });
  // ── C3: promise-only text after tools ──
  it("C3: continues on 'I'll check' promise text after tools with visible content", () => {
    const d = decideContinueToolLoop({
      hadToolCalls: false,
      toolsWereOffered: true,
      emittedContentChars: 60,
      toolRounds: 1,
      toolResultCount: 2,
      continueRetriesUsed: 0,
      maxContinueRetries: 3,
      maxToolRounds: 12,
      lastAssistantText: "I'll check that for you.",
    });
    // C2 triggers first (60 < 80), but C3 reason takes priority via promise detection
    // Actually C2 triggers before C3 in order. Verify it continues.
    expect(d.shouldContinue).toBe(true);
  });

  it("C3: continues on ja '確認します' promise after tools with >80 chars content", () => {
    const d = decideContinueToolLoop({
      hadToolCalls: false,
      toolsWereOffered: true,
      emittedContentChars: 100,
      toolRounds: 1,
      toolResultCount: 2,
      continueRetriesUsed: 0,
      maxContinueRetries: 3,
      maxToolRounds: 12,
      lastAssistantText: "ファイルを確認します。少々お待ちください。",
    });
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe("C3");
  });

  it("C3: does NOT continue on real report text >80 chars", () => {
    const d = decideContinueToolLoop({
      hadToolCalls: false,
      toolsWereOffered: true,
      emittedContentChars: 200,
      toolRounds: 1,
      toolResultCount: 2,
      continueRetriesUsed: 0,
      maxContinueRetries: 3,
      maxToolRounds: 12,
      lastAssistantText: "The file contains 42 lines of TypeScript. I found the function at line 15 and it imports from the utils module.",
    });
    expect(d.shouldContinue).toBe(false);
  });

  it("C3: does NOT continue on promise text when no tools ran", () => {
    const d = decideContinueToolLoop({
      hadToolCalls: false,
      toolsWereOffered: true,
      toolRounds: 0,
      emittedContentChars: 20,
      toolResultCount: 0,
      continueRetriesUsed: 0,
      maxContinueRetries: 3,
      maxToolRounds: 12,
      lastAssistantText: "I'll check that for you.",
    });
    // C1 triggers (20 < MIN_USER_VISIBLE_CHARS=24), which is fine — thinking-only
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe("C1");
  });

  // ── C4: unfinished tool work ──
  it("C4: continues when unfinishedToolWork and content < 400 chars", () => {
    const d = decideContinueToolLoop({
      hadToolCalls: false,
      toolsWereOffered: true,
      emittedContentChars: 150,
      toolRounds: 2,
      toolResultCount: 3,
      continueRetriesUsed: 0,
      maxContinueRetries: 3,
      maxToolRounds: 12,
      unfinishedToolWork: true,
    });
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe("C4");
  });

  it("C4: does NOT continue when unfinishedToolWork but content is substantial", () => {
    const d = decideContinueToolLoop({
      hadToolCalls: false,
      toolsWereOffered: true,
      emittedContentChars: 500,
      toolRounds: 2,
      toolResultCount: 3,
      continueRetriesUsed: 0,
      maxContinueRetries: 3,
      maxToolRounds: 12,
      unfinishedToolWork: true,
    });
    expect(d.shouldContinue).toBe(false);
  });

  it("C4: does NOT continue when no unfinishedToolWork and content >80", () => {
    const d = decideContinueToolLoop({
      hadToolCalls: false,
      toolsWereOffered: true,
      emittedContentChars: 150,
      toolRounds: 2,
      toolResultCount: 3,
      continueRetriesUsed: 0,
      maxContinueRetries: 3,
      maxToolRounds: 12,
      unfinishedToolWork: false,
    });
    expect(d.shouldContinue).toBe(false);
  });

  // ── env threshold ──
  it("parses AGENT_CONTINUE_MIN_CHARS from env", () => {
    expect(agentContinueMinCharsFromEnv({ AGENT_CONTINUE_MIN_CHARS: "120" } as NodeJS.ProcessEnv)).toBe(120);
    expect(agentContinueMinCharsFromEnv({} as NodeJS.ProcessEnv)).toBe(80);
  });

  it("C2 respects custom minChars threshold", () => {
    const d = decideContinueToolLoop({
      hadToolCalls: false,
      toolsWereOffered: true,
      emittedContentChars: 90,
      toolRounds: 1,
      toolResultCount: 2,
      continueRetriesUsed: 0,
      maxContinueRetries: 3,
      maxToolRounds: 12,
      minChars: 120,
    });
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe("C2");
  });
});
