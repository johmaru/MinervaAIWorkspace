import type { Locale } from "./types";
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, SUPPORTED_LOCALES } from "./types";
import { ja, en } from "./dictionaries";

const dictionaries = { ja, en } as const;

/**
 * 翻訳文字列を取得。
 * key は "namespace.key" 形式（例: "common.save"）。
 * params は {key} プレースホルダを置換（例: {count} → 5）。
 * キー不存在時は key をそのまま返す（フォールバック）。
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
 * Route Handler で Cookie からロケールを検出する。
 * Cookie が無い or 不正値の場合は DEFAULT_LOCALE にフォールバック。
 */
export function getRequestLocale(request: Request): Locale {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${LOCALE_COOKIE_NAME}=([^;]+)`));
  const raw = match?.[1] ?? DEFAULT_LOCALE;
  return SUPPORTED_LOCALES.includes(raw as Locale) ? (raw as Locale) : DEFAULT_LOCALE;
}

export type Dictionary = typeof ja;
