"use client";

import { memo, useState, useCallback, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";

import { sanitizeToolCallMarkup } from "@/lib/toolCallSanitizer";
import { remarkRichBlocks } from "@/lib/remarkRichBlocks";
import { Callout, InlineMark, RichList } from "./rich-blocks";

/**
 * Markdown rendering for LLM responses.
 *
 * - remark-gfm: GFM extensions (tables, strikethrough, task lists, etc.)
 * - rehype-highlight: syntax highlighting for code blocks (highlight.js)
 * - rehype-katex: math rendering for $...$ / $$...$$ (KaTeX)
 *
 * User input can remain plain text (no Markdown parsing needed).
 * Incomplete Markdown during streaming is handled tolerantly by react-markdown.
 * Sanitization of tool-call markup is delegated to sanitizeToolCallMarkup.
 */
function PreBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    // Extract text from children
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
  // Block code detection: in addition to the language-* class,
  // also detect via the hljs class that rehype-highlight adds when no language is found.
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
        remarkPlugins={[remarkGfm, remarkDirective, remarkRichBlocks]}
        rehypePlugins={[rehypeHighlight, [rehypeKatex, { throwOnError: false }]]}
        components={{
          // Code blocks: highlight.js generates <pre><code class="language-xxx">
          pre: PreBlock,
          code: CodeBlock,
          // Tables
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
          // Links open in a new tab
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
          // Lists
          ul: ({ children }) => (
            <ul className="my-1 list-disc pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1 list-decimal pl-5">{children}</ol>
          ),
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          // Paragraphs
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          // Blockquotes
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-accent/40 pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          // Rich directive blocks (Task 2+)
          callout: Callout,
          richlist: RichList,
          mark: InlineMark,
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
