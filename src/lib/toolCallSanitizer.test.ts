// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sanitizeToolCallMarkup, hasToolCallMarkup } from "@/lib/toolCallSanitizer";

// Assemble at runtime to avoid placing literal tag strings in source.
const lt = String.fromCharCode(60); // <
const gt = String.fromCharCode(62); // >

describe("sanitizeToolCallMarkup", () => {
  it("removes GLM/Qwen tool_call complete form, keeping preceding and following text", () => {
    const tc = lt + "tool_call" + gt;
    const tcc = lt + "/tool_call" + gt;
    const ak = lt + "arg_key" + gt;
    const akc = lt + "/arg_key" + gt;
    const av = lt + "arg_value" + gt;
    const avc = lt + "/arg_value" + gt;
    const content =
      "調べてみますね。\n\n" +
      tc + "search_web" + ak + "query" + akc + av + "GLM ラテン語" + avc + tcc +
      "\nGLM-5.2 は多くの言語を扱えます。";
    const result = sanitizeToolCallMarkup(content);
    expect(result).toContain("調べてみますね。");
    expect(result).toContain("GLM-5.2 は多くの言語を扱えます。");
    expect(result).not.toMatch(/tool_call/);
    expect(result).not.toMatch(/arg_value/);
  });

  it("removes GLM/Qwen tool_call streaming partial (no closing tag), keeping preceding text", () => {
    const tc = lt + "tool_call" + gt;
    const ak = lt + "arg_key" + gt;
    const akc = lt + "/arg_key" + gt;
    const av = lt + "arg_value" + gt;
    const content = "調べてみますね。\n" + tc + "search_web" + ak + "query" + akc + av + "partial";
    const result = sanitizeToolCallMarkup(content);
    expect(result).toContain("調べてみますね。");
    expect(result).not.toMatch(/tool_call/);
    expect(result).not.toMatch(/arg_value/);
  });

  it("removes XML tag format <search_web>…</search_web>", () => {
    const content = '確認します。\n<search_web>query="test query"</search_web>\n回答です。';
    const result = sanitizeToolCallMarkup(content);
    expect(result).toContain("確認します。");
    expect(result).toContain("回答です。");
    expect(result).not.toMatch(/search_web/);
    expect(result).not.toMatch(/query=/);
  });

  it("removes code fence format", () => {
    const content = '確認します。\n```search_web\nquery="test"\n```\n回答です。';
    const result = sanitizeToolCallMarkup(content);
    expect(result).toContain("確認します。");
    expect(result).toContain("回答です。");
    expect(result).not.toMatch(/search_web/);
  });

  it("does not remove legitimate HTML (<details>, <summary>)", () => {
    const content = "<details><summary>詳細</summary>中身</details>";
    const result = sanitizeToolCallMarkup(content);
    expect(result).toBe(content);
  });

  it("does not modify normal Markdown", () => {
    const content = "# 見出し\n\n**太字** と *斜体* と `code`。\n\n- リスト1\n- リスト2";
    const result = sanitizeToolCallMarkup(content);
    expect(result).toBe(content);
  });

  it("returns empty string when content is only markup", () => {
    const tc = lt + "tool_call" + gt;
    const tcc = lt + "/tool_call" + gt;
    const content = tc + "search_web" + tcc;
    const result = sanitizeToolCallMarkup(content);
    expect(result).toBe("");
  });
});

describe("hasToolCallMarkup", () => {
  it("returns true when content contains tool_call markup", () => {
    const tc = lt + "tool_call" + gt;
    const content = "調べてみます。\n" + tc + "search_web";
    expect(hasToolCallMarkup(content)).toBe(true);
  });

  it("returns false for normal content", () => {
    const content = "GLM-5.2 は多くの言語を扱えます。\n\n詳細な回答です。";
    expect(hasToolCallMarkup(content)).toBe(false);
  });

  it("returns true when content contains code fence format tool call", () => {
    const content = '```search_web\nquery="test"';
    expect(hasToolCallMarkup(content)).toBe(true);
  });

  it("returns true when content contains XML tag format tool call", () => {
    const content = '<search_web>query="test"</search_web>';
    expect(hasToolCallMarkup(content)).toBe(true);
  });
});
