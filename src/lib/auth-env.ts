/**
 * AUTH_URL environment management for dual-access (local + Cloudflare).
 *
 * Auth.js v5 reqWithEnvURL (node_modules/next-auth/lib/env.js) rewrites every
 * request's origin to process.env.AUTH_URL when it is set. That makes
 * AUTH_URL sticky: if it points at localhost, public visits redirect to
 * localhost; if it points at the public host, local visits redirect to the
 * public origin. Both break dual access.
 *
 * Fix: neutralizeAuthUrlForDualAccess() copies AUTH_URL into
 * UMANS_CONFIGURED_AUTH_URL (the UI/OAuth-console base) and then deletes
 * process.env.AUTH_URL so Auth.js falls through to request headers under
 * AUTH_TRUST_HOST=true. Redirects then follow the incoming host (see
 * src/lib/request-origin.ts resolvePublicOrigin).
 *
 * This module touches process.env only — no Node fs/path — so it is safe to
 * import from both the edge proxy (src/proxy.ts) and the Node auth config
 * (src/auth.ts).
 */

export const CONFIGURED_AUTH_URL_ENV = "UMANS_CONFIGURED_AUTH_URL";

const DEFAULT_AUTH_URL = "http://localhost:3001";

/**
 * Call once at module load (auth.ts and proxy.ts, first import).
 * Copies AUTH_URL → UMANS_CONFIGURED_AUTH_URL when the mirror is empty,
 * then always deletes process.env.AUTH_URL (and NEXTAUTH_URL) so Auth.js
 * uses request headers under AUTH_TRUST_HOST.
 *
 * Idempotent: safe to call from both proxy.ts and auth.ts.
 */
export function neutralizeAuthUrlForDualAccess(): void {
  const authUrl = process.env.AUTH_URL;
  const nextAuthUrl = process.env.NEXTAUTH_URL;

  // Preserve the configured value in the mirror env var when empty
  if (authUrl && !process.env[CONFIGURED_AUTH_URL_ENV]) {
    process.env[CONFIGURED_AUTH_URL_ENV] = authUrl;
  }

  // Always clear AUTH_URL / NEXTAUTH_URL so reqWithEnvURL is a no-op and
  // Auth.js derives the origin from request headers (AUTH_TRUST_HOST=true).
  if (authUrl) delete process.env.AUTH_URL;
  if (nextAuthUrl) delete process.env.NEXTAUTH_URL;
}

/**
 * Reads the configured public base URL for UI / OAuth-console alignment.
 * Prefers the neutralized mirror, then AUTH_URL (if not yet neutralized),
 * then the localhost default. Does NOT re-inject into process.env.AUTH_URL.
 */
export function getConfiguredAuthUrl(): string {
  return (
    process.env[CONFIGURED_AUTH_URL_ENV] ??
    process.env.AUTH_URL ??
    DEFAULT_AUTH_URL
  );
}

/**
 * Sets the configured public base URL (from Settings GUI / tunnel API).
 * Writes UMANS_CONFIGURED_AUTH_URL and deletes process.env.AUTH_URL so
 * Auth.js does not pick up a sticky origin.
 */
export function setConfiguredAuthUrl(url: string): void {
  process.env[CONFIGURED_AUTH_URL_ENV] = url;
  // Ensure Auth.js does not read a sticky AUTH_URL
  delete process.env.AUTH_URL;
  delete process.env.NEXTAUTH_URL;
}
