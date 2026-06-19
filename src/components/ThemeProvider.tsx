"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * next-themes ラッパー。
 * ダークモード切替を SSR 安全に提供する。
 * attribute="class" → <html class="dark"> を付与し Tailwind v4 の .dark と連動。
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
