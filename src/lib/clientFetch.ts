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
    window.location.href = "/login";
    // ページ遷移中でも呼び出し元で await が解決するよう、そのまま返す。
    // 遷移が完了すれば後続処理は無意味だが、エラーにはならない。
  }
  return res;
}
