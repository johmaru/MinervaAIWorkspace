import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export const { auth } = NextAuth(authConfig);

/**
 * Next.js 16 Proxy（旧 middleware）。
 * /api/* は除外（各ルートが独自認証）。ページルートのみ authorized でゲート。
 * 未認証のページアクセス → /login にリダイレクト。
 */
export default auth;

export const config = {
  // /api/*, _next/static, _next/image, favicon.ico を除外
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
