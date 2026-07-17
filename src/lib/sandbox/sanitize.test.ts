// @vitest-environment node
import { describe, it, expect } from "vitest";
import { sanitizeToolOutput } from "./sanitize";

describe("sanitizeToolOutput", () => {
  it("returns empty string unchanged with no truncation", () => {
    const result = sanitizeToolOutput("", 4096);
    expect(result).toEqual({ text: "", truncated: false });
  });

  it("keeps normal text and newlines", () => {
    const input = "print('hi')\nhello world\n";
    const result = sanitizeToolOutput(input, 4096);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("keeps tabs", () => {
    const input = "col1\tcol2\tcol3";
    const result = sanitizeToolOutput(input, 4096);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("strips NUL bytes", () => {
    const input = "before\x00after";
    const result = sanitizeToolOutput(input, 4096);
    expect(result.text).toBe("beforeafter");
  });
  it("strips C0 control chars except \\n \\t (ESC removed, leaves printable CSI body)", () => {
    // ESC [ 2 J (clear screen) + bell + form feed + vertical tab
    // Only the control chars are removed; the printable CSI body "[2J" remains.
    // Full ANSI-sequence stripping is intentionally NOT done here (Tier 1 light
    // sanitize = control chars only; classification is a Tier 2+ concern).
    const input = "ok\x1b[2Jdone\x07\x0c\x0b";
    const result = sanitizeToolOutput(input, 4096);
    expect(result.text).toBe("ok[2Jdone");
  });

  it("strips DEL (0x7F)", () => {
    const input = "a\x7fb";
    const result = sanitizeToolOutput(input, 4096);
    expect(result.text).toBe("ab");
  });

  it("strips C1 control chars (0x80-0x9F)", () => {
    const input = "a\x84b\x9Fc";
    const result = sanitizeToolOutput(input, 4096);
    expect(result.text).toBe("abc");
  });

  it("preserves multi-byte UTF-8 (Japanese)", () => {
    const input = "こんにちは\n世界";
    const result = sanitizeToolOutput(input, 4096);
    expect(result.text).toBe(input);
  });

  it("truncates at maxChars boundary", () => {
    const input = "0123456789ABCDEF"; // 16 chars
    const result = sanitizeToolOutput(input, 10);
    expect(result.text).toBe("0123456789");
    expect(result.truncated).toBe(true);
  });

  it("does not truncate when exactly at limit", () => {
    const input = "0123456789"; // 10 chars
    const result = sanitizeToolOutput(input, 10);
    expect(result.text).toBe(input);
    expect(result.truncated).toBe(false);
  });

  it("truncation happens after control-char stripping", () => {
    // Control chars removed first, then length cap applies to the cleaned text.
    const input = "a\x00b\x00c\x00d\x00e\x00f\x00g\x00h\x00i\x00j\x00k";
    const result = sanitizeToolOutput(input, 5);
    expect(result.text).toBe("abcde");
    expect(result.truncated).toBe(true);
  });

  it("handles very long input efficiently", () => {
    const input = "x".repeat(100_000);
    const result = sanitizeToolOutput(input, 4096);
    expect(result.text.length).toBe(4096);
    expect(result.truncated).toBe(true);
  });

  it("maxChars of 0 produces empty string with truncated flag", () => {
    const result = sanitizeToolOutput("hello", 0);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
  });
});
