/**
 * Microsoft identity platform OAuth 2.0 shared helper.
 *
 * Used by outlook.ts and outlook-calendar.ts.
 *
 * Verified endpoints (2026-07-17, learn.microsoft.com):
 * - Auth:  https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
 * - Token: https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   (same URL for exchange AND refresh; form-urlencoded)
 * - Graph: https://graph.microsoft.com/v1.0
 *
 * tenant = MICROSOFT_TENANT_ID or "common".
 * offline_access scope is REQUIRED to get refresh tokens.
 * Token response: access_token, refresh_token, expires_in (seconds),
 * scope, token_type=Bearer.
 *
 * Env: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID
 */

export type MicrosoftTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

export type MicrosoftUserInfo = {
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  id: string | null;
};

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function getTenant(): string {
  return process.env.MICROSOFT_TENANT_ID || "common";
}

function getMicrosoftCredentials(): { clientId: string; clientSecret: string; tenant: string } {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET is not set",
    );
  }
  return { clientId, clientSecret, tenant: getTenant() };
}

function tokenUrl(): string {
  return `https://login.microsoftonline.com/${getTenant()}/oauth2/v2.0/token`;
}

function authUrl(): string {
  return `https://login.microsoftonline.com/${getTenant()}/oauth2/v2.0/authorize`;
}

/**
 * Builds the Microsoft OAuth authorize URL.
 * Always includes offline_access for refresh tokens.
 */
export function buildMicrosoftAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  scope: string,
): string {
  // Ensure offline_access is always present
  const scopes = scope.includes("offline_access")
    ? scope
    : `${scope} offline_access`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes,
    state,
  });
  return `${authUrl()}?${params}`;
}

/**
 * Exchanges an authorization code for tokens + fetches user profile.
 */
export async function exchangeMicrosoftCode(
  code: string,
  redirectUri: string,
  scope: string,
): Promise<MicrosoftTokenResponse & { user: MicrosoftUserInfo }> {
  const { clientId, clientSecret, tenant } = getMicrosoftCredentials();

  const scopes = scope.includes("offline_access")
    ? scope
    : `${scope} offline_access`;

  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: scopes,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Microsoft token exchange failed: ${res.status} ${errText}`);
  }
  const token = (await res.json()) as MicrosoftTokenResponse;
  if (!token.access_token) {
    throw new Error("Microsoft token exchange returned no access_token");
  }

  const user = await fetchMicrosoftUserInfo(token.access_token);
  return { ...token, user };
}

/**
 * Refreshes a Microsoft access token.
 */
export async function refreshMicrosoftToken(
  refreshToken: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}> {
  const { clientId, clientSecret } = getMicrosoftCredentials();

  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Microsoft token refresh failed: ${res.status} ${errText}`);
  }
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
}

/**
 * Fetches the authenticated user's profile from Graph /me.
 */
async function fetchMicrosoftUserInfo(accessToken: string): Promise<MicrosoftUserInfo> {
  try {
    const res = await fetch(`${GRAPH_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { displayName: null, mail: null, userPrincipalName: null, id: null };
    const data = (await res.json()) as {
      displayName?: string;
      mail?: string;
      userPrincipalName?: string;
      id?: string;
    };
    return {
      displayName: data.displayName ?? null,
      mail: data.mail ?? null,
      userPrincipalName: data.userPrincipalName ?? null,
      id: data.id ?? null,
    };
  } catch {
    return { displayName: null, mail: null, userPrincipalName: null, id: null };
  }
}

/**
 * Calls the Microsoft Graph API with automatic token refresh on 401.
 * Returns new tokens for DB persistence when refreshed.
 */
export async function callMicrosoftApi(
  accessToken: string,
  refreshToken: string | null,
  method: string,
  url: string,
  body?: unknown,
): Promise<{
  ok: true;
  data: unknown;
  newAccessToken?: string;
  newRefreshToken?: string;
  newExpiresAt?: Date;
} | { ok: false; error: string }> {
  const doFetch = (token: string) =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch(accessToken);

  // 401 → refresh and retry once
  if (res.status === 401) {
    if (!refreshToken) {
      return { ok: false, error: "Access token expired and no refresh token available" };
    }
    try {
      const refreshed = await refreshMicrosoftToken(refreshToken);
      res = await doFetch(refreshed.access_token);
      const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
      if (res.ok) {
        const data = await parseResponseBody(res);
        return {
          ok: true,
          data,
          newAccessToken: refreshed.access_token,
          newRefreshToken: refreshed.refresh_token,
          newExpiresAt,
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
  return { ok: true, data: await parseResponseBody(res) };
}

/** Parses response body as JSON if possible, else returns text. */
async function parseResponseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Computes expiry Date from expires_in seconds. */
export function expiryFromExpiresIn(expiresIn: number): Date {
  return new Date(Date.now() + expiresIn * 1000);
}

export const MICROSOFT_GRAPH_BASE = GRAPH_BASE;
