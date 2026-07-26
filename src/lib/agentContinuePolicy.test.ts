// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  agentContinueRetriesFromEnv,
  shouldContinueToolLoop,
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
});
