import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "@/components/Markdown";

afterEach(() => {
  cleanup();
});

describe("Markdown — basic rendering", () => {
  it("renders plain text as a paragraph", () => {
    render(<Markdown content="こんにちは" />);
    expect(screen.getByText("こんにちは")).toBeInTheDocument();
  });

  it("renders bold text in a strong tag", () => {
    render(<Markdown content={"**太字** のテスト"} />);
    expect(screen.getByText("太字")).toBeInTheDocument();
    expect(screen.getByText("太字").tagName).toBe("STRONG");
  });

  it("renders code blocks in a pre tag", () => {
    render(<Markdown content={"```\nconsole.log('hi')\n```"} />);
    const pre = document.querySelector("pre");
    expect(pre).toBeInTheDocument();
    expect(pre?.textContent).toContain("console.log");
  });

  it("renders inline code in a code tag", () => {
    render(<Markdown content={"`inline code` です"} />);
    const code = screen.getByText("inline code");
    expect(code.tagName).toBe("CODE");
  });

  it("renders GFM tables", () => {
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

  it("renders lists", () => {
    render(<Markdown content={"- 項目1\n- 項目2"} />);
    const ul = document.querySelector("ul");
    expect(ul).toBeInTheDocument();
    const items = document.querySelectorAll("li");
    expect(items).toHaveLength(2);
  });

  it("adds target=_blank and rel=noopener to links", () => {
    render(<Markdown content={"[例](https://example.com)"} />);
    const link = screen.getByText("例");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders headings", () => {
    render(<Markdown content={"## 見出し2"} />);
    expect(screen.getByText("見出し2")).toBeInTheDocument();
  });

  it("renders blockquotes", () => {
    render(<Markdown content={"> 引用文"} />);
    const bq = document.querySelector("blockquote");
    expect(bq).toBeInTheDocument();
    expect(screen.getByText("引用文")).toBeInTheDocument();
  });

  it("does not crash on empty string", () => {
    render(<Markdown content="" />);
    const container = document.querySelector(".markdown-body");
    expect(container).toBeInTheDocument();
  });
});

describe("Markdown — tool-call markup sanitization", () => {
  it("removes XML-tag form of search_web", () => {
    const content = '確認します。\n<search_web>query="test query"</search_web>\n回答です。';
    render(<Markdown content={content} />);
    expect(screen.getByText("確認します。")).toBeInTheDocument();
    expect(screen.getByText("回答です。")).toBeInTheDocument();
    expect(screen.queryByText(/search_web/)).not.toBeInTheDocument();
    expect(screen.queryByText(/query=/)).not.toBeInTheDocument();
  });

  it("removes XML-tag form of scrape_webpage", () => {
    const content = '<scrape_webpage url="https://example.com">content here</scrape_webpage>\n回答です。';
    render(<Markdown content={content} />);
    expect(screen.getByText("回答です。")).toBeInTheDocument();
    expect(screen.queryByText(/scrape_webpage/)).not.toBeInTheDocument();
  });

  it("removes partial XML tags during streaming", () => {
    const content = '確認します。\n<search_web>query="test';
    render(<Markdown content={content} />);
    expect(screen.getByText("確認します。")).toBeInTheDocument();
    expect(screen.queryByText(/search_web/)).not.toBeInTheDocument();
    expect(screen.queryByText(/query=/)).not.toBeInTheDocument();
  });

  it("also removes code-fence form", () => {
    const content = '確認します。\n```search_web\nquery="test"\n```\n回答です。';
    render(<Markdown content={content} />);
    expect(screen.getByText("確認します。")).toBeInTheDocument();
    expect(screen.getByText("回答です。")).toBeInTheDocument();
    expect(screen.queryByText(/search_web/)).not.toBeInTheDocument();
  });

  it("becomes empty when only tool markup is present", () => {
    const content = '<search_web>query="test"</search_web>';
    const { container } = render(<Markdown content={content} />);
    expect(container.querySelector(".markdown-body")).toBeInTheDocument();
    expect(container.textContent?.trim()).toBe("");
  });

  it("removes GLM/Qwen tool_call form of search_web", () => {
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

  it("removes partial GLM/Qwen tool_call tags during streaming", () => {
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

  it("becomes empty when only GLM/Qwen tool_call form is present", () => {
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
