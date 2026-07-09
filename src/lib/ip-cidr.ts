/**
 * IP/CIDR matching utilities.
 * Supports IPv4 single IP + CIDR, IPv6 single IP + CIDR.
 * Invalid entries are silently treated as non-matching (never throw).
 *
 * Note: uses BigInt() constructor (not n suffix) because tsconfig targets ES2017.
 */
import { isIP } from "node:net";

const IPV4_BITS = BigInt(32);
const IPV6_BITS = BigInt(128);
const ZERO = BigInt(0);
const ONE = BigInt(1);
const EIGHT = BigInt(8);
const SIXTEEN = BigInt(16);
const BYTE_MAX = BigInt(255);
const WORD_MAX = BigInt(0xffff);

/** Parse an IPv4 dotted-quad into a BigInt, or null if invalid. */
function parseIPv4(ip: string): bigint | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = ZERO;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << EIGHT) | BigInt(n);
  }
  return result;
}

/** Parse an IPv6 address string into a BigInt, or null if invalid. */
function parseIPv6(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  // Expand :: shorthand into 8 groups
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const groups: bigint[] = [];
  try {
    for (const g of headParts) {
      const n = BigInt("0x" + g);
      if (n < ZERO || n > WORD_MAX) return null;
      groups.push(n);
    }
    for (let i = 0; i < missing; i++) groups.push(ZERO);
    for (const g of tailParts) {
      const n = BigInt("0x" + g);
      if (n < ZERO || n > WORD_MAX) return null;
      groups.push(n);
    }
  } catch {
    return null; // BigInt parse failure on invalid hex
  }
  if (groups.length !== 8) return null;
  let result = ZERO;
  for (const g of groups) {
    result = (result << SIXTEEN) | g;
  }
  return result;
}

/** Compute a CIDR mask: prefix bits set, rest zero. */
function cidrMask(prefix: number, totalBits: bigint): bigint {
  if (prefix === 0) return ZERO;
  const p = BigInt(prefix);
  return ((ONE << p) - ONE) << (totalBits - p);
}

/** Check if an IP matches a single entry (IP or CIDR). Never throws. */
function matchEntry(ip: string, entry: string): boolean {
  const entryTrimmed = entry.trim();
  if (!entryTrimmed) return false;

  // CIDR notation: ip/prefix
  if (entryTrimmed.includes("/")) {
    const slashIdx = entryTrimmed.indexOf("/");
    const cidrIp = entryTrimmed.slice(0, slashIdx);
    const prefixStr = entryTrimmed.slice(slashIdx + 1);
    const prefix = Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0) return false;

    // IPv4 CIDR
    const ipV4 = parseIPv4(ip);
    const cidrV4 = parseIPv4(cidrIp);
    if (ipV4 !== null && cidrV4 !== null) {
      if (prefix > 32) return false;
      const mask = cidrMask(prefix, IPV4_BITS);
      return (ipV4 & mask) === (cidrV4 & mask);
    }

    // IPv6 CIDR
    const ipV6 = parseIPv6(ip);
    const cidrV6 = parseIPv6(cidrIp);
    if (ipV6 !== null && cidrV6 !== null) {
      if (prefix > 128) return false;
      const mask = cidrMask(prefix, IPV6_BITS);
      return (ipV6 & mask) === (cidrV6 & mask);
    }
    return false;
  }

  // Plain IP — exact match within the same family
  const ipV4 = parseIPv4(ip);
  const entryV4 = parseIPv4(entryTrimmed);
  if (ipV4 !== null && entryV4 !== null) {
    return ipV4 === entryV4;
  }
  const ipV6 = parseIPv6(ip);
  const entryV6 = parseIPv6(entryTrimmed);
  if (ipV6 !== null && entryV6 !== null) {
    return ipV6 === entryV6;
  }
  return false;
}

/**
 * Returns true if `ip` matches any entry in the comma-separated `list`.
 * Invalid IPs/CIDRs in the list are silently skipped.
 */
export function isIPInList(ip: string, list: string): boolean {
  const entries = list.split(",").map((e) => e.trim()).filter(Boolean);
  for (const entry of entries) {
    if (matchEntry(ip, entry)) return true;
  }
  return false;
}
