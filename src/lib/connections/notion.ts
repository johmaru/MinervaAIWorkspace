/**
 * Notion OAuth クライアント。
 *
 * - exchangeNotionCode: 認可コード → アクセストークン交換（HTTP Basic 認証）
 * - refreshNotionToken: リフレッシュトークンでアクセストークン更新
 * - callNotionApi: Notion API 呼び出し（401 時に自動リフレッシュ＆1回リトライ）
 *
 * Notion アクセストークンは長寿命だが、ユーザー取り消し等で無効化されうる。
 * 401 を検知したらリフレッシュしてリトライし、新しいトークンを呼び出し元へ返す。
 */

const NOTION_VERSION = "2026-03-11";
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const API_BASE = "https://api.notion.com/v1";

export type NotionTokenResponse = {
  access_token: string;
  refresh_token: string;
  bot_id: string;
  duplicated_template_id: string | null;
  owner: { type: "user"; user: { id: string; name: string | null; email: string | null } };
  workspace_icon: string | null;
  workspace_id: string;
  workspace_name: string | null;
};

function basicAuthHeader(): string {
  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("NOTION_CLIENT_ID or NOTION_CLIENT_SECRET is not set");
  }
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return `Basic ${encoded}`;
}

/**
 * 認可コードをアクセストークンと交換する。
 * Notion のトークンエンドポイントは HTTP Basic 認証（CLIENT_ID:CLIENT_SECRET）を要求する。
 */
export async function exchangeNotionCode(
  code: string,
  redirectUri: string,
): Promise<NotionTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion token exchange failed: ${res.status} ${text}`);
  }
  return (await res.json()) as NotionTokenResponse;
}

/**
 * リフレッシュトークンで新しいアクセストークンを取得する。
 * 古い refresh_token は無効化され、新しい refresh_token が返される。
 */
export async function refreshNotionToken(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion token refresh failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token: string };
  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

/**
 * Notion API を呼び出す。401 の場合はトークンをリフレッシュして1回リトライする。
 * リフレッシュされた場合、新しいトークンを呼び出し元へ返す（DB へ永続化のため）。
 */
export async function callNotionApi(
  accessToken: string,
  refreshToken: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<
  | { ok: true; data: unknown; newAccessToken?: string; newRefreshToken?: string }
  | { ok: false; error: string }
> {
  const doFetch = (token: string) =>
    fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch(accessToken);

  // 401 → リフレッシュしてリトライ
  if (res.status === 401) {
    try {
      const refreshed = await refreshNotionToken(refreshToken);
      res = await doFetch(refreshed.access_token);
      if (res.ok) {
        const data = await res.json();
        return {
          ok: true,
          data,
          newAccessToken: refreshed.access_token,
          newRefreshToken: refreshed.refresh_token,
        };
      }
      return { ok: false, error: await res.text() };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Token refresh failed",
      };
    }
  }

  if (!res.ok) {
    return { ok: false, error: await res.text() };
  }
  return { ok: true, data: await res.json() };
}
