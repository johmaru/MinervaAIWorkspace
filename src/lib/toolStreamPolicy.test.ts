// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  resolveBufferedToolRoundContent,
  TOOL_GROUNDING_REMINDER,
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

