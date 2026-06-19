"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";

/**
 * LLM 応答の Markdown レンダリング。
 *
 * - remark-gfm: テーブル・打消し線・タスクリスト等の GFM 拡張
 * - rehype-highlight: コードブロックのシンタックスハイライト (highlight.js)
 * - rehype-katex: $...$ / $$...$$ の数式レンダリング (KaTeX)
 *
 * ユーザー入欄はプレーンテキストのままでよい（Markdown パース不要）。
 * ストリーミング中の不完全な Markdown は react-markdown が寛容に扱う。
 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeKatex]}
        components={{
          // コードブロック: highlight.js が <pre><code class="language-xxx"> を生成
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-2xl bg-muted p-3 text-xs ring-1 ring-border">
              {children}
            </pre>
          ),
          code: ({ className, children, ...props }) => {
            // インラインコード（language-* クラスがない場合）
            const isInline = !className?.includes("language-");
            if (isInline) {
              return (
                <code
                  className="rounded bg-muted px-1 py-0.5 text-xs font-mono"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
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
        {content}
      </ReactMarkdown>
    </div>
  );
}
