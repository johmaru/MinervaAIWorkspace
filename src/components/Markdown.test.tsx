import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "@/components/Markdown";

afterEach(() => {
  cleanup();
});

describe("Markdown — 基本レンダリング", () => {
  it("プレーンテキストを段落として描画", () => {
    render(<Markdown content="こんにちは" />);
    expect(screen.getByText("こんにちは")).toBeInTheDocument();
  });

  it("太字を strong タグで描画", () => {
    render(<Markdown content={"**太字** のテスト"} />);
    expect(screen.getByText("太字")).toBeInTheDocument();
    expect(screen.getByText("太字").tagName).toBe("STRONG");
  });

  it("コードブロックを pre タグで描画", () => {
    render(<Markdown content={"```\nconsole.log('hi')\n```"} />);
    const pre = document.querySelector("pre");
    expect(pre).toBeInTheDocument();
    expect(pre?.textContent).toContain("console.log");
  });

  it("インラインコードを code タグで描画", () => {
    render(<Markdown content={"`inline code` です"} />);
    const code = screen.getByText("inline code");
    expect(code.tagName).toBe("CODE");
  });

  it("GFM テーブルを描画", () => {
    render(
      <Markdown
        content={"| A | B |\n|---|---|\n| 1 | 2 |"}
      />,
    );
    const table = document.querySelector("table");
    expect(table).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("リストを描画", () => {
    render(<Markdown content={"- 項目1\n- 項目2"} />);
    const ul = document.querySelector("ul");
    expect(ul).toBeInTheDocument();
    const items = document.querySelectorAll("li");
    expect(items).toHaveLength(2);
  });

  it("リンクに target=_blank と rel=noopener を付与", () => {
    render(<Markdown content={"[例](https://example.com)"} />);
    const link = screen.getByText("例");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("見出しを描画", () => {
    render(<Markdown content={"## 見出し2"} />);
    expect(screen.getByText("見出し2")).toBeInTheDocument();
  });

  it("ブロック引用を描画", () => {
    render(<Markdown content={"> 引用文"} />);
    const bq = document.querySelector("blockquote");
    expect(bq).toBeInTheDocument();
    expect(screen.getByText("引用文")).toBeInTheDocument();
  });

  it("空文字でもクラッシュしない", () => {
    render(<Markdown content="" />);
    const container = document.querySelector(".markdown-body");
    expect(container).toBeInTheDocument();
  });
});

describe("Markdown — ツール呼び出しマークアップのサニタイズ", () => {
  it("XMLタグ形式の search_web を削除", () => {
    const content = '確認します。\n<search_web>query="test query"</search_web>\n回答です。';
    render(<Markdown content={content} />);
    expect(screen.getByText("確認します。")).toBeInTheDocument();
    expect(screen.getByText("回答です。")).toBeInTheDocument();
    expect(screen.queryByText(/search_web/)).not.toBeInTheDocument();
    expect(screen.queryByText(/query=/)).not.toBeInTheDocument();
  });

  it("XMLタグ形式の scrape_webpage を削除", () => {
    const content = '<scrape_webpage url="https://example.com">content here</scrape_webpage>\n回答です。';
    render(<Markdown content={content} />);
    expect(screen.getByText("回答です。")).toBeInTheDocument();
    expect(screen.queryByText(/scrape_webpage/)).not.toBeInTheDocument();
  });

  it("ストリーミング中の部分的なXMLタグを削除", () => {
    const content = '確認します。\n<search_web>query="test';
    render(<Markdown content={content} />);
    expect(screen.getByText("確認します。")).toBeInTheDocument();
    expect(screen.queryByText(/search_web/)).not.toBeInTheDocument();
    expect(screen.queryByText(/query=/)).not.toBeInTheDocument();
  });

  it("コードフェンス形式も引き続き削除", () => {
    const content = '確認します。\n```search_web\nquery="test"\n```\n回答です。';
    render(<Markdown content={content} />);
    expect(screen.getByText("確認します。")).toBeInTheDocument();
    expect(screen.getByText("回答です。")).toBeInTheDocument();
    expect(screen.queryByText(/search_web/)).not.toBeInTheDocument();
  });

  it("ツールマークアップのみの場合は空になる", () => {
    const content = '<search_web>query="test"</search_web>';
    const { container } = render(<Markdown content={content} />);
    expect(container.querySelector(".markdown-body")).toBeInTheDocument();
    expect(container.textContent?.trim()).toBe("");
  });

  it("GLM/Qwen tool_call形式の search_web を削除", () => {
    const tc = String.fromCharCode(60) + "tool_call" + String.fromCharCode(62);
    const tcc = String.fromCharCode(60) + "/tool_call" + String.fromCharCode(62);
    const ak = String.fromCharCode(60) + "arg_key" + String.fromCharCode(62);
    const akc = String.fromCharCode(60) + "/arg_key" + String.fromCharCode(62);
    const av = String.fromCharCode(60) + "arg_value" + String.fromCharCode(62);
    const avc = String.fromCharCode(60) + "/arg_value" + String.fromCharCode(62);
    const content = "確認します。\n\n" + tc + "search_web" + ak + "query" + akc + av + "test query" + avc + tcc + "\n回答です。";
    render(<Markdown content={content} />);
    expect(screen.getByText("確認します。")).toBeInTheDocument();
    expect(screen.getByText("回答です。")).toBeInTheDocument();
    expect(screen.queryByText(/search_web/)).not.toBeInTheDocument();
    expect(screen.queryByText(/arg_value/)).not.toBeInTheDocument();
  });

  it("GLM/Qwen tool_call形式、ストリーミング中の部分タグを削除", () => {
    const tc = String.fromCharCode(60) + "tool_call" + String.fromCharCode(62);
    const ak = String.fromCharCode(60) + "arg_key" + String.fromCharCode(62);
    const akc = String.fromCharCode(60) + "/arg_key" + String.fromCharCode(62);
    const av = String.fromCharCode(60) + "arg_value" + String.fromCharCode(62);
    const content = "確認します。\n" + tc + "search_web" + ak + "query" + akc + av + "partial";
    render(<Markdown content={content} />);
    expect(screen.getByText("確認します。")).toBeInTheDocument();
    expect(screen.queryByText(/search_web/)).not.toBeInTheDocument();
    expect(screen.queryByText(/arg_value/)).not.toBeInTheDocument();
  });

  it("GLM/Qwen tool_call形式のみの場合は空になる", () => {
    const tc = String.fromCharCode(60) + "tool_call" + String.fromCharCode(62);
    const tcc = String.fromCharCode(60) + "/tool_call" + String.fromCharCode(62);
    const ak = String.fromCharCode(60) + "arg_key" + String.fromCharCode(62);
    const akc = String.fromCharCode(60) + "/arg_key" + String.fromCharCode(62);
    const av = String.fromCharCode(60) + "arg_value" + String.fromCharCode(62);
    const avc = String.fromCharCode(60) + "/arg_value" + String.fromCharCode(62);
    const content = tc + "search_web" + ak + "query" + akc + av + "test" + avc + tcc;
    const { container } = render(<Markdown content={content} />);
    expect(container.querySelector(".markdown-body")).toBeInTheDocument();
    expect(container.textContent?.trim()).toBe("");
  });
});
