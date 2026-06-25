// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sanitizeToolCallMarkup, hasToolCallMarkup } from "@/lib/toolCallSanitizer";

// リテラルタグ文字列をソースに置かないよう、実行時に組み立てる。
const lt = String.fromCharCode(60); // <
const gt = String.fromCharCode(62); // >

describe("sanitizeToolCallMarkup", () => {
  it("GLM/Qwen tool_call 完全形を除去し前文と後文を残す", () => {
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

  it("GLM/Qwen tool_call ストリーミング部分（閉じタグなし）を除去し前文を残す", () => {
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

  it("XMLタグ形式 <search_web>…</search_web> を除去する", () => {
    const content = '確認します。\n<search_web>query="test query"</search_web>\n回答です。';
    const result = sanitizeToolCallMarkup(content);
    expect(result).toContain("確認します。");
    expect(result).toContain("回答です。");
    expect(result).not.toMatch(/search_web/);
    expect(result).not.toMatch(/query=/);
  });

  it("コードフェンス形式を除去する", () => {
    const content = '確認します。\n```search_web\nquery="test"\n```\n回答です。';
    const result = sanitizeToolCallMarkup(content);
    expect(result).toContain("確認します。");
    expect(result).toContain("回答です。");
    expect(result).not.toMatch(/search_web/);
  });

  it("正規の HTML（<details>, <summary>）は除去しない", () => {
    const content = "<details><summary>詳細</summary>中身</details>";
    const result = sanitizeToolCallMarkup(content);
    expect(result).toBe(content);
  });

  it("通常の Markdown は変更しない", () => {
    const content = "# 見出し\n\n**太字** と *斜体* と `code`。\n\n- リスト1\n- リスト2";
    const result = sanitizeToolCallMarkup(content);
    expect(result).toBe(content);
  });

  it("マークアップのみの場合は空文字列を返す", () => {
    const tc = lt + "tool_call" + gt;
    const tcc = lt + "/tool_call" + gt;
    const content = tc + "search_web" + tcc;
    const result = sanitizeToolCallMarkup(content);
    expect(result).toBe("");
  });
});

describe("hasToolCallMarkup", () => {
  it("tool_call マークアップを含む場合 true を返す", () => {
    const tc = lt + "tool_call" + gt;
    const content = "調べてみます。\n" + tc + "search_web";
    expect(hasToolCallMarkup(content)).toBe(true);
  });

  it("通常コンテンツの場合 false を返す", () => {
    const content = "GLM-5.2 は多くの言語を扱えます。\n\n詳細な回答です。";
    expect(hasToolCallMarkup(content)).toBe(false);
  });

  it("コードフェンス形式のツール呼び出しを含む場合 true を返す", () => {
    const content = '```search_web\nquery="test"';
    expect(hasToolCallMarkup(content)).toBe(true);
  });

  it("XMLタグ形式のツール呼び出しを含む場合 true を返す", () => {
    const content = '<search_web>query="test"</search_web>';
    expect(hasToolCallMarkup(content)).toBe(true);
  });
});
