/**
 * Google OAuth 2.0 shared helper for Google Connections providers.
 *
 * Used by gmail.ts, google-drive.ts, google-calendar.ts.
 *
 * Verified endpoints (2026-07-17, developers.google.com):
 * - Auth:  https://accounts.google.com/o/oauth2/v2/auth
 * - Token: https://oauth2.googleapis.com/token (same URL for exchange AND refresh)
 *
 * Token response: access_token, expires_in (seconds ~3600),
 * refresh_token (first consent only), scope, token_type=Bearer.
 * Refresh may rotate refresh_token — persist if present.
 *
 * Env: GOOGLE_CONNECTIONS_CLIENT_ID, GOOGLE_CONNECTIONS_CLIENT_SECRET
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
};

export type GoogleUserInfo = {
  email: string | null;
  name: string | null;
  picture: string | null;
  id: string | null;
};

/**
 * Builds the Google OAuth authorize URL.
 * Uses access_type=offline + prompt=consent to ensure refresh_token.
 */
export function buildGoogleAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  scope: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params}`;
}

function getGoogleCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CONNECTIONS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CONNECTIONS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CONNECTIONS_CLIENT_ID or GOOGLE_CONNECTIONS_CLIENT_SECRET is not set",
    );
  }
  return { clientId, clientSecret };
}

/**
 * Exchanges an authorization code for tokens + fetches user profile.
 */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  scope: string,
): Promise<GoogleTokenResponse & { user: GoogleUserInfo }> {
  const { clientId, clientSecret } = getGoogleCredentials();

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${errText}`);
  }
  const token = (await res.json()) as GoogleTokenResponse;
  if (!token.access_token) {
    throw new Error("Google token exchange returned no access_token");
  }

  const user = await fetchGoogleUserInfo(token.access_token);
  return { ...token, user };
}

/**
 * Refreshes a Google access token. May return a new refresh_token (rotation).
 */
export async function refreshGoogleToken(
  refreshToken: string,
): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}> {
  const { clientId, clientSecret } = getGoogleCredentials();

  const res = await fetch(TOKEN_URL, {
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
    throw new Error(`Google token refresh failed: ${res.status} ${errText}`);
  }
  return (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
}

/**
 * Fetches the authenticated user's profile for display metadata.
 * Uses the userinfo endpoint (requires no extra scope beyond OAuth).
 */
async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { email: null, name: null, picture: null, id: null };
    const data = (await res.json()) as {
      email?: string;
      name?: string;
      picture?: string;
      id?: string;
    };
    return {
      email: data.email ?? null,
      name: data.name ?? null,
      picture: data.picture ?? null,
      id: data.id ?? null,
    };
  } catch {
    return { email: null, name: null, picture: null, id: null };
  }
}

/**
 * Calls a Google API with automatic token refresh on 401.
 * Returns new tokens for DB persistence when refreshed.
 *
 * @param accessToken - Current access token
 * @param refreshToken - Current refresh token (null = no refresh possible)
 * @param method - HTTP method
 * @param url - Full URL (including query params)
 * @param body - JSON body for POST/PUT (optional)
 * @param headers - Extra headers (optional)
 */
export async function callGoogleApi(
  accessToken: string,
  refreshToken: string | null,
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
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
        ...headers,
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
      const refreshed = await refreshGoogleToken(refreshToken);
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
  // Content-Type may be missing or text/plain; try JSON parse for API responses
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
