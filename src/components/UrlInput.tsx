"use client";

import { useCallback, useState } from "react";
import { useI18n } from "@/components/I18nProvider";

type Props = {
  onScraped?: (title: string) => void;
};

/**
 * URL 取り込み入力欄。Enter で POST /api/scrape を呼び、
 * ページをスクレイピングして恒久ナレッジ化する。
 */
export function UrlInput({ onScraped }: Props) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = url.trim();
      if (!trimmed || status === "loading") return;
      setStatus("loading");
      setMessage("");
      try {
        const res = await fetch("/api/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
        });
        const data = (await res.json()) as {
          title?: string;
          url?: string;
          cached?: boolean;
          error?: string;
        };
        if (!res.ok) {
          setStatus("error");
          setMessage(data.error || t("urlInput.httpError", { status: res.status }));
          return;
        }
        setStatus("done");
        setMessage(data.cached ? t("urlInput.cached") : t("urlInput.imported"));
        onScraped?.(data.title || data.url || "");
        setUrl("");
      } catch {
        setStatus("error");
        setMessage(t("common.communicationError"));
      }
    },
    [url, status, onScraped, t],
  );

  return (
    <form onSubmit={handleSubmit} className="relative px-2 pb-1">
      <div className="flex items-center gap-1">
        <span className="text-xs" aria-hidden="true">🌐</span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("urlInput.placeholder")}
          aria-label={t("urlInput.label")}
          disabled={status === "loading"}
          className="w-full rounded-2xl bg-muted px-2 py-1.5 text-xs outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20 disabled:opacity-50"
        />
        {status === "loading" && (
        <span className="animate-pulse text-xs text-muted-foreground" aria-hidden="true">…</span>
        )}
      </div>
      {message && (
        <p
          role="status"
          className={`mt-1 text-[10px] ${status === "error" ? "text-red-500" : "text-muted-foreground"}`}
        >
          {message}
        </p>
      )}
    </form>
  );
}
