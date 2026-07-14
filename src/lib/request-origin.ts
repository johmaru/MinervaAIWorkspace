/**
 * Pure origin resolution helpers — edge-safe (no Node APIs).
 *
 * Used by auth.config.ts (proxy) and OAuth route handlers to derive the
 * correct public origin from request headers, independent of the sticky
 * AUTH_URL env var that Auth.js would otherwise use to rewrite request
 * origins (see node_modules/next-auth/lib/env.js reqWithEnvURL).
 *
 * Dual-access contract: redirects always follow the incoming request host
 * (x-forwarded-host / host + x-forwarded-proto). A local Host stays local
 * even when a public AUTH_URL is configured — AUTH_URL is only a fallback
 * for when no host header is present at all.
 */

/**
 * Returns true for local-only hostnames: localhost, 127.0.0.1, ::1, [::1],
 * and any *.localhost subdomain (case-insensitive). Accepts the bracketed
 * IPv6 form that Node's URL.hostname returns.
 */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".localhost")
  );
}

/**
 * Returns true if the given URL or origin string parses and its hostname
 * is local. Returns false on invalid URLs.
 */
export function isLocalOrigin(urlOrOrigin: string): boolean {
  try {
    const u = new URL(urlOrOrigin);
    return isLocalHostname(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Extracts the hostname from a Host header value (may include a port or
 * IPv6 brackets). Returns null if the value cannot be parsed.
 */
function hostnameFromHost(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Derives the protocol for a host header value when x-forwarded-proto is
 * absent: https for port 443 or no port, else http.
 */
function protoFromHost(headers: Headers, host: string): string {
  const explicit = headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .replace(/:$/, "");
  if (explicit) return explicit;
  try {
    const port = new URL(`http://${host}`).port;
    return !port || port === "443" ? "https" : "http";
  } catch {
    return "https";
  }
}

/**
 * Resolves the public origin for redirects from the incoming request headers,
 * falling back to a configured AUTH_URL only when no host header is present.
 *
 * Resolution order:
 * 1. x-forwarded-host (first entry) → host header (first entry).
 *    If present and parseable, return `${proto}://${host}` where proto comes
 *    from x-forwarded-proto (or is derived from the port). This applies to
 *    BOTH local and public hosts — a local visit stays local even when a
 *    public AUTH_URL is configured.
 * 2. Else if configuredAuthUrl parses → return its origin.
 * 3. Else return http://localhost:3001.
 */
export function resolvePublicOrigin(
  headers: Headers,
  configuredAuthUrl?: string | null,
): string {
  const xfh = headers.get("x-forwarded-host");
  const rawHost = (xfh ?? headers.get("host"))?.split(",")[0]?.trim();

  // Security: when a public AUTH_URL is configured and the request host is
 // NOT local, prefer AUTH_URL over the host header to prevent Host header
 // injection (e.g. attacker sends Host: evil.com to manipulate OAuth redirect_uri).
 // Local hosts (localhost, 127.0.0.1) are always served from the local origin
 // to preserve the dual-access contract.
  if (rawHost && configuredAuthUrl && !isLocalOrigin(configuredAuthUrl)) {
    const hostHostname = hostnameFromHost(rawHost);
    if (hostHostname !== null && !isLocalHostname(hostHostname)) {
      try {
        return new URL(configuredAuthUrl).origin;
      } catch {
        // Invalid configured URL → fall through to host header
      }
    }
  }

  if (rawHost && hostnameFromHost(rawHost) !== null) {
    return `${protoFromHost(headers, rawHost)}://${rawHost}`;
  }
  if (configuredAuthUrl) {
    try {
      return new URL(configuredAuthUrl).origin;
    } catch {
      // Invalid configured URL → fall through to default
    }
  }

  return "http://localhost:3001";
}
