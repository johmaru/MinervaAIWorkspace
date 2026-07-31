export type Locale = "en" | "ja";

export const SUPPORTED_LOCALES: Locale[] = ["en", "ja"];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE_NAME = "minerva-locale";
export const LOCALE_STORAGE_KEY = "minerva-locale";

/** @deprecated One-release fallback for pre-rename installs */
export const LEGACY_LOCALE_COOKIE_NAME = "umanschat-locale";
/** @deprecated One-release fallback for pre-rename installs */
export const LEGACY_LOCALE_STORAGE_KEY = "umanschat-locale";
