"use client";
import { useI18n } from "@/components/I18nProvider";
import { useEffect, useState } from "react";
import { motion } from "motion/react";

/**
 * 言語切替ボタン（EN / JA）。ThemeToggle と同じパターンで
 * サイドバーヘッダーに配置する。マウント前は hydration 不一致を避けるため空描画。
 */
export function LanguageToggle() {
  const { locale, setLocale } = useI18n();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return (
    <motion.button
      type="button"
      onClick={() => setLocale(locale === "ja" ? "en" : "ja")}
      className="rounded-xl p-2 text-xs font-semibold text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground hover:shadow-md"
      aria-label={locale === "ja" ? "English" : "日本語"}
      title={locale === "ja" ? "English" : "日本語"}
      whileTap={{ scale: 0.9 }}
    >
      {mounted ? (locale === "ja" ? "EN" : "JA") : <span className="block h-4 w-4 animate-pulse rounded bg-muted" />}
    </motion.button>
  );
}
