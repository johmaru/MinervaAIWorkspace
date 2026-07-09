import type { Locale } from "./types";
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, SUPPORTED_LOCALES } from "./types";
import { ja, en } from "./dictionaries";

const dictionaries = { ja, en } as const;

/**
 * Retrieves a translation string.
 * key is in "namespace.key" format (e.g. "common.save").
 * params replaces {key} placeholders (e.g. {count} → 5).
 * If the key does not exist, returns the key as-is (fallback).
 */
export function t(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const dict = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];
  const parts = key.split(".");
  let value: unknown = dict;
  for (const part of parts) {
    value = (value as Record<string, unknown>)?.[part];
    if (value === undefined) break;
  }
  let str = typeof value === "string" ? value : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

/**
 * Detects the locale from a cookie in a Route Handler.
 * Falls back to DEFAULT_LOCALE if the cookie is missing or has an invalid value.
 */
export function getRequestLocale(request: Request): Locale {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${LOCALE_COOKIE_NAME}=([^;]+)`));
  const raw = match?.[1] ?? DEFAULT_LOCALE;
  return SUPPORTED_LOCALES.includes(raw as Locale) ? (raw as Locale) : DEFAULT_LOCALE;
}

export type Dictionary = typeof ja;
