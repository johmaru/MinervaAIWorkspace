import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe Auth.js 設定。
 * proxy.ts はこれのみを import する（DB モジュールを含まない）。
 * authorized コールバックはページルートのみをゲートする。
 * API ルート（/api/*）は matcher で除外され、各ルートが getSessionUser() で独自認証する。
 */
export const authConfig = {
  pages: { signIn: "/login" },
  callbacks: {
    authorized: ({ auth, request }) => {
      const isLoginPage = request.nextUrl.pathname.startsWith("/login");
      // ログイン済みユーザーが /login にアクセス → / にリダイレクト
      if (isLoginPage)
        return !!auth
          ? Response.redirect(new URL("/", request.nextUrl.origin))
          : true; // 未認証でも /login は閲覧可
      // それ以外のページは認証必須; false → /login にリダイレクト
      return !!auth;
    },
  },
  providers: [], // auth.ts で Credentials provider を追加
} satisfies NextAuthConfig;
