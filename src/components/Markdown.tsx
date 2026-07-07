"use client";

import { memo, useState, useCallback, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";

import { sanitizeToolCallMarkup } from "@/lib/toolCallSanitizer";

/**
 * LLM 応答の Markdown レンダリング。
 *
 * - remark-gfm: テーブル・打消し線・タスクリスト等の GFM 拡張
 * - rehype-highlight: コードブロックのシンタックスハイライト (highlight.js)
 * - rehype-katex: $...$ / $$...$$ の数式レンダリング (KaTeX)
 *
 * ユーザー入欄はプレーンテキストのままでよい（Markdown パース不要）。
 * ストリーミング中の不完全な Markdown は react-markdown が寛容に扱う。
 * ツール呼び出しマークアップのサニタイズは sanitizeToolCallMarkup に委譲。
 */
function PreBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    // children からテキストを抽出
    const extractText = (node: React.ReactNode): string => {
      if (typeof node === "string") return node;
      if (typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(extractText).join("");
      if (node && typeof node === "object" && "props" in node) {
        return extractText((node as { props: { children?: React.ReactNode } }).props.children);
      }
      return "";
    };
    const text = extractText(children);
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [children]);
  return (
    <pre className="relative my-2 overflow-x-auto rounded-2xl bg-muted p-3 text-xs ring-1 ring-border group">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
        aria-label="Copy code"
      >
        {copied ? "✓" : "Copy"}
      </button>
      {children}
    </pre>
  );
}

function CodeBlock({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
  // ブロックコード判定: language-* クラスの有無に加え、
  // rehype-highlight が言語未検出時に付与する hljs クラスでも判定する。
  const isBlock = className?.includes("language-") || className?.includes("hljs");
  if (!isBlock) {
    return (
      <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" {...props}>
        {children}
      </code>
    );
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const sanitized = sanitizeToolCallMarkup(content);
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, [rehypeKatex, { throwOnError: false }]]}
        components={{
          // コードブロック: highlight.js が <pre><code class="language-xxx"> を生成
          pre: PreBlock,
          code: CodeBlock,
          // テーブル
          table: ({ children }) => (
            <table className="my-2 w-full border-collapse text-xs">
              {children}
            </table>
          ),
          th: ({ children }) => (
            <th className="border border-border px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1">{children}</td>
          ),
          // リンクは新タブで開く
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline hover:opacity-80"
            >
              {children}
            </a>
          ),
          // リスト
          ul: ({ children }) => (
            <ul className="my-1 list-disc pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1 list-decimal pl-5">{children}</ol>
          ),
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          // 段落
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          // 引用
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-accent/40 pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          h1: ({ children }) => <h1 className="my-2 text-base font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="my-2 text-base font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="my-1.5 text-sm font-bold">{children}</h3>,
          h4: ({ children }) => <h4 className="my-1 text-sm font-bold">{children}</h4>,
          hr: () => <hr className="my-3 border-border" />,
        }}
      >
        {sanitized}
      </ReactMarkdown>
    </div>
  );
});
