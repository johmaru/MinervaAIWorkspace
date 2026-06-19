"use client";

import { useCallback, useState } from "react";
import { useI18n } from "@/components/I18nProvider";

export type SearchResult = {
  messageId: string;
  threadId: string;
  threadTitle: string;
  role: string;
  content: string;
  similarity: number;
};

export type PageSearchResult = {
  pageId: string;
  url: string;
  title: string;
  content: string;
  similarity: number;
};

type Props = {
  onSelectThread: (threadId: string) => void;
};

/**
 * スレッド横断セマンティック検索バー。
 * 入力すると POST /api/search にクエリを送り、
 * 類似メッセージをスレッドタイトル + スニペット付きで表示。
 * 結果クリックで対象スレッドに遷移。
 */
export function SearchBar({ onSelectThread }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pageResults, setPageResults] = useState<PageSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);

  const handleSearch = useCallback(async (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      setResults([]);
      setPageResults([]);
      setShowResults(false);
      return;
    }
    setIsSearching(true);
    setShowResults(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        results: SearchResult[];
        pages?: PageSearchResult[];
      };
      setResults(data.results);
      setPageResults(data.pages ?? []);
    } catch {
      setResults([]);
      setPageResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleSelect = useCallback(
    (threadId: string) => {
      onSelectThread(threadId);
      setShowResults(false);
      setQuery("");
      setResults([]);
      setPageResults([]);
    },
    [onSelectThread],
  );

  const hasAny = results.length > 0 || pageResults.length > 0;

  return (
    <div className="relative px-2 pb-1">
      <input
        type="text"
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        onFocus={() => hasAny && setShowResults(true)}
        onBlur={() => setTimeout(() => setShowResults(false), 200)}
        placeholder={t("search.placeholder")}
        aria-label={t("search.label")}
        className="w-full rounded-2xl bg-muted px-3 py-2 text-xs outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
      />
      {showResults && (
        <div className="absolute left-2 right-2 top-full z-10 mt-1 max-h-80 overflow-y-auto rounded-2xl bg-popover p-1 shadow-xl ring-1 ring-border">
          {isSearching ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">{t("search.searching")}</p>
          ) : !hasAny ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {query.trim() ? t("search.noResults") : t("search.enterKeyword")}
            </p>
          ) : (
            <ul className="flex flex-col">
              {pageResults.length > 0 && (
                <li className="border-b border-border px-2 py-1" aria-label={t("search.webKnowledgeResults")}>
                  <p className="text-[10px] text-muted-foreground">{t("search.webKnowledge")}</p>
                </li>
              )}
              {pageResults.map((p) => (
                <li key={p.pageId}>
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full flex-col gap-0.5 rounded-xl px-2 py-2 text-left text-xs transition-colors duration-150 hover:bg-muted"
                  >
                    <span className="flex items-center justify-between">
                      <span className="truncate font-medium text-foreground">
                        {p.title || p.url}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {Math.round(p.similarity * 100)}%
                      </span>
                    </span>
                    <span className="line-clamp-2 text-muted-foreground">
                      {p.content}
                    </span>
                  </a>
                </li>
              ))}
              {results.map((r) => (
                <li key={r.messageId}>
                  <button
                    type="button"
                    onClick={() => handleSelect(r.threadId)}
                    className="flex w-full flex-col gap-0.5 rounded-xl px-2 py-2 text-left text-xs transition-colors duration-150 hover:bg-muted"
                  >
                    <span className="flex items-center justify-between">
                      <span className="truncate font-medium text-foreground">
                        {r.threadTitle}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {Math.round(r.similarity * 100)}%
                      </span>
                    </span>
                    <span className="line-clamp-2 text-muted-foreground">
                      {r.content}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
