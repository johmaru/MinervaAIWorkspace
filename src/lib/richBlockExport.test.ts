// @vitest-environment node
import { describe, expect, it } from "vitest";
import { convertRichBlocksForExport } from "./richBlockExport";

describe("convertRichBlocksForExport", () => {
  it("converts callout to Obsidian native syntax", () => {
    const out = convertRichBlocksForExport(':::callout{type="warning"}\nbody line\n:::');
    expect(out.trim()).toBe("> [!warning]\n> body line");
  });

  it("converts callout with title", () => {
    const out = convertRichBlocksForExport(':::callout{type="tip" title="Hint"}\nbody\n:::');
    expect(out.trim()).toBe("> [!tip] Hint\n> body");
  });

  it("falls back to [!note] for unknown type", () => {
    const out = convertRichBlocksForExport(':::callout{type="bogus"}\nbody\n:::');
    expect(out).toContain("> [!note]");
  });

  it("converts richlist to plain list", () => {
    const out = convertRichBlocksForExport(':::richlist{marker="check"}\n- one\n- two\n:::');
    expect(out).toBe("- one\n- two");
  });

  it("strips mark inline styling to plain text", () => {
    const out = convertRichBlocksForExport("a :mark[b]{.big} c");
    expect(out).toBe("a b c");
  });

  it("leaves plain markdown untouched", () => {
    const out = convertRichBlocksForExport("# Title\n\nplain **bold**");
    expect(out).toBe("# Title\n\nplain **bold**");
  });
});
