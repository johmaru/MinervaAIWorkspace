// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  resolveBufferedToolRoundContent,
  shouldForceFinalAnswer,
  TOOL_GROUNDING_REMINDER,
  FINAL_ANSWER_REQUIRED_REMINDER,
} from "./toolStreamPolicy";

describe("resolveBufferedToolRoundContent", () => {
  it("returns null when tools were not offered (already live-streamed)", () => {
    expect(
      resolveBufferedToolRoundContent({
        toolsOffered: false,
        hadToolCalls: false,
        bufferedContent: "hello",
      }),
    ).toBeNull();
  });

  it("discards buffered narration when the round had tool_calls", () => {
    expect(
      resolveBufferedToolRoundContent({
        toolsOffered: true,
        hadToolCalls: true,
        bufferedContent: "I confirmed StoryPart.text exists",
      }),
    ).toBeNull();
  });

  it("flushes buffer when tools were offered but no tool_calls (final prose)", () => {
    expect(
      resolveBufferedToolRoundContent({
        toolsOffered: true,
        hadToolCalls: false,
        bufferedContent: "Final answer from tools.",
      }),
    ).toBe("Final answer from tools.");
  });

  it("returns null for empty buffer even without tool_calls", () => {
    expect(
      resolveBufferedToolRoundContent({
        toolsOffered: true,
        hadToolCalls: false,
        bufferedContent: "",
      }),
    ).toBeNull();
  });
});

describe("TOOL_GROUNDING_REMINDER", () => {
  it("forbids inventing fields and requires tool-output grounding", () => {
    expect(TOOL_GROUNDING_REMINDER).toMatch(/ONLY on tool outputs/i);
    expect(TOOL_GROUNDING_REMINDER).toMatch(/Do NOT invent/i);
    expect(TOOL_GROUNDING_REMINDER).toMatch(/\[SEARCH empty\]/);
  });
});

describe("shouldForceFinalAnswer", () => {
  it("forces when no user-visible content was emitted", () => {
    expect(shouldForceFinalAnswer({ emittedContentChars: 0, forceWhenEmpty: true })).toBe(true);
  });

  it("does not force when content already reached the user", () => {
    expect(shouldForceFinalAnswer({ emittedContentChars: 12, forceWhenEmpty: true })).toBe(false);
  });

  it("respects forceWhenEmpty=false", () => {
    expect(shouldForceFinalAnswer({ emittedContentChars: 0, forceWhenEmpty: false })).toBe(false);
  });
});

describe("FINAL_ANSWER_REQUIRED_REMINDER", () => {
  it("requires content not thinking-only and no tools", () => {
    expect(FINAL_ANSWER_REQUIRED_REMINDER).toMatch(/user-visible/i);
    expect(FINAL_ANSWER_REQUIRED_REMINDER).toMatch(/thinking/i);
    expect(FINAL_ANSWER_REQUIRED_REMINDER).toMatch(/Do not call tools/i);
  });
});
