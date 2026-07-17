/**
 * Notion OAuth client.
 *
 * - exchangeNotionCode: authorization code → access token exchange (HTTP Basic auth)
 * - refreshNotionToken: refreshes the access token using the refresh token
 * - callNotionApi: calls the Notion API (auto-refreshes and retries once on 401)
 *
 * Notion access tokens are long-lived but can be invalidated by user revocation, etc.
 * On detecting a 401, it refreshes and retries, returning the new tokens to the caller.
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
 * Exchanges an authorization code for an access token.
 * Notion's token endpoint requires HTTP Basic auth (CLIENT_ID:CLIENT_SECRET).
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
 * Obtains a new access token using the refresh token.
 * The old refresh_token is invalidated, and a new refresh_token is returned.
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
 * Calls the Notion API. On 401, refreshes the token and retries once.
 * If refreshed, returns the new tokens to the caller (for DB persistence).
 */
export async function callNotionApi(
  accessToken: string,
  refreshToken: string | null,
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

  // 401 → refresh and retry
  if (res.status === 401) {
    if (!refreshToken) {
      return { ok: false, error: "Access token expired and no refresh token available" };
    }
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
