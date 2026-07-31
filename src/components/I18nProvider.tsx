"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Locale } from "@/lib/i18n/types";
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, LOCALE_STORAGE_KEY, LEGACY_LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from "@/lib/i18n/types";
import { t as tFunction } from "@/lib/i18n";

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Client-side i18n Provider.
 * Persists locale to localStorage and syncs cookie and <html lang>.
 * Same pattern as next-themes: render with DEFAULT_LOCALE during SSR,
 * then re-render on the client after restoring from localStorage.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  // Restore from localStorage on first mount.
  // try-catch guards against unavailable localStorage (e.g. private mode).
  // Also update <html lang> on restore to prevent screen reader misreads
  // caused by mismatch between SSR lang="en" and client ja.
  useEffect(() => {
    try {
      const stored =
        localStorage.getItem(LOCALE_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_LOCALE_STORAGE_KEY);
      if (stored && SUPPORTED_LOCALES.includes(stored as Locale)) {
        setLocaleState(stored as Locale);
        document.documentElement.lang = stored;
        // Promote legacy key to the new name
        localStorage.setItem(LOCALE_STORAGE_KEY, stored);
      }
    } catch {
      // localStorage unavailable (e.g. private mode) — ignore
    }
  }, []);

  // Update localStorage + cookie + <html lang> when locale changes
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // localStorage unavailable — ignore
    }
    document.cookie = `${LOCALE_COOKIE_NAME}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = next;
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => tFunction(locale, key, params),
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
