// @vitest-environment node
/**
 * SSRF guard for remote MCP servers (http/sse transports).
 *
 * Validates the URL scheme and host before any network request is made.
 * Default posture: https-only, reject private/loopback/link-local/metadata IPs.
 * Set MCP_ALLOW_PRIVATE_URLS=true to relax for self-host/dev (e.g. http://localhost:3001/mcp).
 *
 * This guard is applied at API write time (POST/PATCH) and at connect time,
 * so a saved private URL only connects when the env override is active.
 */

/** Private IPv4 ranges (CIDR). Checked via integer comparison. */
const PRIVATE_IPV4_PREFIXES: ReadonlyArray<{ start: number; end: number }> = [
  { start: 0x00000000, end: 0x00ffffff }, // 0.0.0.0/8 — "this network"
  { start: 0x0a000000, end: 0x0affffff }, // 10.0.0.0/8 — private
  { start: 0x7f000000, end: 0x7fffffff }, // 127.0.0.0/8 — loopback
  { start: 0xa9fe0000, end: 0xa9feffff }, // 169.254.0.0/16 — link-local + metadata (169.254.169.254)
  { start: 0xac100000, end: 0xac1fffff }, // 172.16.0.0/12 — private
  { start: 0xc0a80000, end: 0xc0a8ffff }, // 192.168.0.0/16 — private
  { start: 0xc6120000, end: 0xc613ffff }, // 198.18.0.0/15 — benchmarking
  { start: 0xe0000000, end: 0xffffffff }, // 224.0.0.0/4 — multicast, 240.0.0.0/4 — reserved
];

/** Cloud metadata endpoints commonly targeted by SSRF. */
const METADATA_HOSTS: Record<string, true> = {
  "169.254.169.254": true, // AWS / GCP / Azure IMDS
  "metadata.google.internal": true, // GCP
  "metadata.azure.com": true, // Azure
  "100.100.100.200": true, // Alibaba
};

export type UrlGuardResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/**
 * Returns true if the host string is an IPv4 address in dotted-quad form.
 */
function isIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d+$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/**
 * Converts a dotted-quad IPv4 address to a 32-bit unsigned integer.
 * Returns null if the input is not a valid IPv4 address.
 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => p < 0 || p > 255)) return null;
  // Use unsigned 32-bit arithmetic
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return PRIVATE_IPV4_PREFIXES.some((r) => n >= r.start && n <= r.end);
}

/**
 * Returns true if the host string is an IPv6 address (contains ':').
 * Checks for loopback (::1), link-local (fe80::/10), and other private ranges.
 */
function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  // Strip zone ID: fe80::1%eth0
  const addr = h.split("%")[0];
  if (addr === "::1") return true; // loopback
  if (addr.startsWith("fe8") || addr.startsWith("fe9") || addr.startsWith("fea") || addr.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique-local fc00::/7
  if (addr === "::") return true; // unspecified
  return false;
}
/**
 * Validates a remote MCP URL against SSRF rules.
 *
 * - https: always allowed (subject to host check)
 * - http: only allowed when MCP_ALLOW_PRIVATE_URLS=true (since http to public hosts is insecure;
 *   when the override is on, http is typically used for LAN/loopback self-host)
 * - Rejects private IPv4/IPv6, loopback, link-local, and metadata IPs by default
 * - Honors MCP_ALLOW_PRIVATE_URLS=true to allow private hosts (self-host/dev)
 *
 * @returns `{ ok: true, url: URL }` on success, `{ ok: false, reason }` on rejection
 */
export function assertMcpRemoteUrl(rawUrl: string): UrlGuardResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `scheme '${url.protocol}' not allowed (use http or https)` };
  }

  // Disallow credentials embedded in URL — they leak in logs and server access logs.
  if (url.username || url.password) {
    return { ok: false, reason: "URL must not contain embedded credentials" };
  }

  // Disallow query-string tokens (plan anti-pattern: no query-string tokens).
  // Query params are unusual for MCP endpoints and a common place to stash leaked secrets.
  if (url.search) {
    return { ok: false, reason: "URL must not contain a query string" };
  }

  const allowPrivate = process.env.MCP_ALLOW_PRIVATE_URLS === "true";
  // url.hostname returns IPv6 with surrounding brackets (e.g. "[::1]"); strip them.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // When private URLs are NOT allowed, enforce https-only for remote servers.
  // http:// is only permitted under the private-urls override (typically LAN/loopback self-host).
  if (!allowPrivate && url.protocol === "http:") {
    return { ok: false, reason: "http URLs require MCP_ALLOW_PRIVATE_URLS=true (use https)" };
  }

  // Reject private IPs unless override is active.
  if (!allowPrivate) {
    if (METADATA_HOSTS[host]) {
      return { ok: false, reason: "metadata IP blocked (SSRF guard)" };
    }
    if (isIPv4(host) && isPrivateIPv4(host)) {
      return { ok: false, reason: "private IP blocked (SSRF guard); set MCP_ALLOW_PRIVATE_URLS=true for self-host" };
    }
    if (host.includes(":") && isPrivateIPv6(host)) {
      return { ok: false, reason: "private IPv6 blocked (SSRF guard); set MCP_ALLOW_PRIVATE_URLS=true for self-host" };
    }
    // Reject localhost and common loopback hostnames.
    if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback") {
      return { ok: false, reason: "localhost blocked (SSRF guard); set MCP_ALLOW_PRIVATE_URLS=true for self-host" };
    }
  }

  return { ok: true, url };
}

/**
 * Normalizes and validates a headers object for remote MCP servers.
 *
 * - Trims keys and values
 * - Drops empty keys/values
 * - Enforces max entry count (default 20) and max value length (default 4096)
 * - Returns null if the resulting object is empty
 */
export function normalizeMcpHeaders(
  raw: Record<string, string> | null | undefined,
  opts: { maxEntries?: number; maxValueLength?: number } = {},
): Record<string, string> | null {
  const maxEntries = opts.maxEntries ?? 20;
  const maxValueLength = opts.maxValueLength ?? 4096;
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    const k = key.trim();
    const v = value.trim();
    if (!k || !v) continue;
    if (v.length > maxValueLength) {
      throw new Error(`header value for '${k}' exceeds ${maxValueLength} chars`);
    }
    out[k] = v;
    if (Object.keys(out).length > maxEntries) {
      throw new Error(`too many headers (max ${maxEntries})`);
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}
