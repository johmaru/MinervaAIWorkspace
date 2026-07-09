"use client";

import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useI18n } from "@/components/I18nProvider";
import { clientFetch } from "@/lib/clientFetch";

type Props = {
  onScraped?: (title: string) => void;
};

/**
 * URL import input. Calls POST /api/scrape on Enter,
 * scrapes the page and persists it as permanent knowledge.
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
        const res = await clientFetch("/api/scrape", {
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
      <AnimatePresence>
        {message && (
          <motion.p
            role="status"
            className={`mt-1 text-[10px] ${status === "error" ? "text-red-500" : "text-muted-foreground"}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            {message}
          </motion.p>
        )}
      </AnimatePresence>
    </form>
  );
}
