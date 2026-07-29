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

describe("Markdown — rich blocks: inline styling", () => {
  it("applies big class to wrapped text", () => {
    const { container } = render(<Markdown content="これは:mark[重要]{.big}です" />);
    const span = container.querySelector("span.text-\\[1\\.25em\\]");
    expect(span?.textContent).toBe("重要");
  });

  it("falls back to plain text for unknown class", () => {
    const { container } = render(<Markdown content=":mark[x]{.bogus}" />);
    expect(container.textContent).toContain("x");
    expect(container.querySelector("span.text-\\[")).toBeNull();
  });

  it("handles array className from hastscript", () => {
    const { container } = render(<Markdown content=":mark[small]{.small}" />);
    const span = container.querySelector("span.text-\\[0\\.8em\\]");
    expect(span?.textContent).toBe("small");
  });

  it("applies highlight class", () => {
    const { container } = render(<Markdown content=":mark[hl]{.hl}" />);
    const span = container.querySelector("span.rounded");
    expect(span?.textContent).toBe("hl");
  });
});

describe("Markdown — rich blocks: callout", () => {
  it("renders a callout with type=warning", () => {
    render(<Markdown content={':::callout{type="warning"}\n注意書き\n:::'} />);
    const box = document.querySelector("div.border-l-yellow-500");
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain("注意書き");
  });

  it("falls back to note for unknown type", () => {
    render(<Markdown content={':::callout{type="bogus"}\n本文\n:::'} />);
    const box = document.querySelector("div.border-l-blue-500");
    expect(box).not.toBeNull();
  });

  it("renders title header when provided", () => {
    render(<Markdown content={':::callout{type="tip" title="ヒント"}\n本文\n:::'} />);
    expect(screen.getByText("ヒント")).not.toBeNull();
  });
});

describe("Markdown — rich blocks: richlist", () => {
  it("prefixes each li with the check icon", () => {
    const { container } = render(<Markdown content={':::richlist{marker="check"}\n- one\n- two\n:::'} />);
    const icons = container.querySelectorAll("svg.lucide-check");
    expect(icons.length).toBe(2);
    expect(container.querySelector("ul.list-disc")).toBeNull();
    expect(container.querySelector("ul.list-none")).not.toBeNull();
  });

  it("falls back to info marker for unknown", () => {
    const { container } = render(<Markdown content={':::richlist{marker="bogus"}\n- x\n:::'} />);
    expect(container.querySelectorAll("svg.lucide-info").length).toBe(1);
    expect(container.querySelector("ul.list-disc")).toBeNull();
  });
});

describe("Markdown — rich blocks: streaming safety", () => {
  it("does not crash on unclosed callout", () => {
    expect(() => render(<Markdown content={':::callout{type="warning"}\nbody so far'} />)).not.toThrow();
  });

  it("does not crash on unclosed richlist", () => {
    expect(() => render(<Markdown content={':::richlist{marker="check"}\n- one'} />)).not.toThrow();
  });

  it("does not crash on unclosed mark", () => {
    expect(() => render(<Markdown content=":mark[unfinished" />)).not.toThrow();
  });
});
