"use client";

/**
 * クライアント側 fetch ラッパー。
 * 401（未認証・セッション無効）検出時、/login へ自動リダイレクトする。
 * DB 再作成等で JWT の userId が users テーブルに存在しなくなった場合、
 * サーバーが 401 を返すため、ここで補足してログイン画面へ遷移させる。
 */
export async function clientFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    // 401 = セッション無効（DB 再作成等で JWT の userId が存在しない）。
    // 認証 Cookie を削除して /login へ遷移。
    // Cookie 削除がないと authorized コールバックが旧 JWT を有効と判定し、
    // /login → / → API 401 → /login の無限ループになる。
    document.cookie.split(";").forEach((c) => {
      const name = c.split("=")[0].trim();
      if (name.startsWith("authjs") || name.startsWith("next-auth")) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      }
    });
    window.location.href = "/login";
  }
  return res;
}
