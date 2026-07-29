// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  recordToolResult,
  shouldForceFinalAnswer,
  buildForcedReportPrompt,
  formatAutoUserReport,
  hasUserVisibleContent,
  MIN_USER_VISIBLE_CHARS,
  type ToolTranscriptEntry,
} from "./agentHooks";

describe("hasUserVisibleContent", () => {
  it("rejects empty or tiny bodies", () => {
    expect(hasUserVisibleContent(0)).toBe(false);
    expect(hasUserVisibleContent(MIN_USER_VISIBLE_CHARS - 1)).toBe(false);
    expect(hasUserVisibleContent(MIN_USER_VISIBLE_CHARS)).toBe(true);
  });
});

describe("recordToolResult", () => {
  it("appends and truncates long content", () => {
    const t: ToolTranscriptEntry[] = [];
    recordToolResult(t, { name: "kb_create", content: "x".repeat(5000), round: 1 }, 100);
    expect(t).toHaveLength(1);
    expect(t[0]!.content.length).toBeLessThan(200);
    expect(t[0]!.content).toContain("truncated");
  });
});

describe("shouldForceFinalAnswer", () => {
  it("forces when no visible answer yet", () => {
    expect(shouldForceFinalAnswer({ emittedContentChars: 0, toolRounds: 2 })).toBe(true);
    expect(shouldForceFinalAnswer({ emittedContentChars: 0, toolRounds: 0 })).toBe(true);
  });
  it("forces tiny content after tools", () => {
    expect(shouldForceFinalAnswer({ emittedContentChars: 5, toolRounds: 1 })).toBe(true);
  });
  it("leaves tiny content alone when no tools ran", () => {
    expect(shouldForceFinalAnswer({ emittedContentChars: 2, toolRounds: 0 })).toBe(false);
  });
  it("skips when a real answer was already streamed", () => {
    expect(shouldForceFinalAnswer({ emittedContentChars: 100, toolRounds: 2 })).toBe(false);
  });
});

describe("buildForcedReportPrompt", () => {
  it("embeds tool results and forbids thinking-only", () => {
    const p = buildForcedReportPrompt([
      { name: "kb_create", content: "kb_id=abc", round: 1 },
    ]);
    expect(p).toMatch(/CONTENT/i);
    expect(p).toContain("kb_create");
    expect(p).toContain("kb_id=abc");
    expect(p).toMatch(/Do NOT call tools/i);
  });

  it("emphasizes honest reporting of error/empty/blocked status", () => {
    const p = buildForcedReportPrompt([
      { name: "search_files", content: "[tool=search_files status=empty] No files found.", round: 1 },
    ]);
    expect(p).toMatch(/status=error.*status=empty.*status=blocked/i);
  });
});

describe("formatAutoUserReport — status tags", () => {
  it("includes status tag when tool content has status= token", () => {
    const r = formatAutoUserReport({
      locale: "en",
      toolRounds: 1,
      tools: [
        { name: "search_files", content: "[tool=search_files status=empty] No files matched.", round: 1 },
      ],
    });
    expect(r).toContain("[empty]");
  });
});

describe("formatAutoUserReport", () => {
  it("always returns non-empty Japanese report with tool lines", () => {
    const r = formatAutoUserReport({
      locale: "ja",
      toolRounds: 3,
      tools: [
        { name: "kb_ingest_jsonl", content: "ingested=52", round: 2 },
      ],
    });
    expect(r.length).toBeGreaterThan(20);
    expect(r).toContain("自動報告");
    expect(r).toContain("kb_ingest_jsonl");
    expect(r).toContain("ingested=52");
  });

  it("handles empty tool list", () => {
    const r = formatAutoUserReport({ locale: "en", toolRounds: 0, tools: [] });
    expect(r).toMatch(/Auto-report/i);
  });
});
