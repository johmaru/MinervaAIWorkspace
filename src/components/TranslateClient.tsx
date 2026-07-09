"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Languages, ArrowLeft, Copy, Check, Loader2 } from "lucide-react";
import { MotionButton, fadeSlideUp } from "@/components/ui/motion";
import { clientFetch } from "@/lib/clientFetch";
import { useI18n } from "@/components/I18nProvider";

type Language = {
  code: string;
  name: string;
  enName: string;
};

const LANGUAGES: Language[] = [
  { code: "auto", name: "自動検出", enName: "Auto detect" },
  { code: "ja", name: "日本語", enName: "Japanese" },
  { code: "en", name: "英語", enName: "English" },
  { code: "zh", name: "中国語（簡体）", enName: "Chinese (Simplified)" },
  { code: "ko", name: "韓国語", enName: "Korean" },
  { code: "es", name: "スペイン語", enName: "Spanish" },
  { code: "fr", name: "フランス語", enName: "French" },
  { code: "de", name: "ドイツ語", enName: "German" },
  { code: "pt", name: "ポルトガル語", enName: "Portuguese" },
  { code: "ru", name: "ロシア語", enName: "Russian" },
  { code: "ar", name: "アラビア語", enName: "Arabic" },
  { code: "it", name: "イタリア語", enName: "Italian" },
  { code: "vi", name: "ベトナム語", enName: "Vietnamese" },
  { code: "th", name: "タイ語", enName: "Thai" },
];

const SOURCE_LANGUAGES = LANGUAGES;
const TARGET_LANGUAGES = LANGUAGES.filter((l) => l.code !== "auto");

type TranslationEntry = {
  id: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  translation: string;
  timestamp: number;
};

export function TranslateClient() {
  const { t, locale } = useI18n();
  const [sourceText, setSourceText] = useState("");
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState(locale === "en" ? "en" : "ja");
  const [translation, setTranslation] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [history, setHistory] = useState<TranslationEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const langLabel = (lang: Language) =>
    locale === "en" ? lang.enName : lang.name;

  const sourceLangObj = SOURCE_LANGUAGES.find((l) => l.code === sourceLang);
  const targetLangObj = TARGET_LANGUAGES.find((l) => l.code === targetLang);

  const handleTranslate = useCallback(async () => {
    if (!sourceText.trim() || status === "loading") return;
    setStatus("loading");
    setTranslation("");
    try {
      const res = await clientFetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: sourceText,
          targetLang: targetLangObj?.enName ?? targetLang,
          sourceLang: sourceLang === "auto" ? undefined : sourceLangObj?.enName,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { translation: string };
      setTranslation(data.translation);
      setStatus("idle");
      const entry: TranslationEntry = {
        id: crypto.randomUUID(),
        sourceText: sourceText.slice(0, 200),
        sourceLang,
        targetLang,
        translation: data.translation,
        timestamp: Date.now(),
      };
      setHistory((prev) => [entry, ...prev].slice(0, 20));
    } catch (err) {
      console.error("[translate] failed:", err);
      setStatus("error");
    }
  }, [sourceText, status, targetLang, sourceLang, targetLangObj, sourceLangObj]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleTranslate();
      }
    },
    [handleTranslate],
  );

  const handleCopy = useCallback(async () => {
    if (!translation) return;
    try {
      await navigator.clipboard.writeText(translation);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — ignore
    }
  }, [translation]);

  const sourceLangLabel = (code: string) => {
    const lang = SOURCE_LANGUAGES.find((l) => l.code === code);
    return lang ? langLabel(lang) : code;
  };
  const targetLangLabel = (code: string) => {
    const lang = TARGET_LANGUAGES.find((l) => l.code === code);
    return lang ? langLabel(lang) : code;
  };

  const canTranslate = sourceText.trim().length > 0 && status !== "loading";

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-xl px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>{t("translate.backToChat")}</span>
        </Link>
        <h1 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Languages className="h-4 w-4" />
          {t("translate.title")}
        </h1>
        <div className="w-32" />
      </header>

      {/* Main translation area */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 lg:flex-row">
        {/* Source pane */}
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              {t("translate.sourceLabel")}
            </label>
            <select
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
              className="rounded-lg bg-muted px-2 py-1 text-xs text-foreground ring-1 ring-border focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {SOURCE_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {langLabel(lang)}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("translate.inputPlaceholder")}
            className="min-h-[200px] flex-1 resize-none rounded-2xl bg-muted p-4 text-sm text-foreground ring-1 ring-border placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <MotionButton
            type="button"
            onClick={handleTranslate}
            disabled={!canTranslate}
            whileTap={canTranslate ? { scale: 0.97 } : undefined}
            className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground ring-1 ring-border transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "loading" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("translate.translating")}
              </>
            ) : (
              <>
                <Languages className="h-4 w-4" />
                {t("translate.translateButton")}
              </>
            )}
          </MotionButton>
        </div>

        {/* Target pane */}
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              {t("translate.targetLabel")}
            </label>
            <div className="flex items-center gap-2">
              <select
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
                className="rounded-lg bg-muted px-2 py-1 text-xs text-foreground ring-1 ring-border focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {TARGET_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {langLabel(lang)}
                  </option>
                ))}
              </select>
              <MotionButton
                type="button"
                onClick={handleCopy}
                disabled={!translation}
                whileTap={translation ? { scale: 0.95 } : undefined}
                className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-xs text-foreground ring-1 ring-border transition-all hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-green-500" />
                    {t("translate.copied")}
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    {t("translate.copy")}
                  </>
                )}
              </MotionButton>
            </div>
          </div>
          <div className="min-h-[200px] flex-1 overflow-y-auto rounded-2xl bg-muted p-4 text-sm text-foreground ring-1 ring-border">
            {status === "error" ? (
              <p className="text-red-500">{t("translate.error")}</p>
            ) : translation ? (
              <p className="whitespace-pre-wrap">{translation}</p>
            ) : (
              <p className="text-muted-foreground/60">
                {t("translate.resultPlaceholder")}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* History */}
      <div className="border-t border-border p-4">
        <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
          {t("translate.history")}
        </h2>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground/60">
            {t("translate.historyEmpty")}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {history.map((entry) => (
                <motion.div
                  key={entry.id}
                  variants={fadeSlideUp}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  layout
                  className="rounded-xl bg-muted/60 px-3 py-2 text-xs text-foreground ring-1 ring-border"
                >
                  <span className="font-medium text-muted-foreground">
                    {sourceLangLabel(entry.sourceLang)} → {targetLangLabel(entry.targetLang)}:
                  </span>{" "}
                  <span className="line-clamp-1">
                    &ldquo;{entry.sourceText}&rdquo; → &ldquo;{entry.translation}&rdquo;
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
