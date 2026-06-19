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
