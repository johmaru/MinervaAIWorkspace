import { headers } from "next/headers";
import { isIPInList } from "./ip-cidr";

/**
 * Returns the client IP, honoring Cf-Connecting-IP (Cloudflare Tunnel)
 * and falling back to X-Forwarded-For first entry.
 */
export async function getClientIp(): Promise<string | null> {
  const h = await headers();
  const cf = h.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return null;
}

/**
 * Returns true if registration is IP-restricted AND the request IP is allowed.
 * When ALLOWED_REGISTRATION_IPS is unset/empty, returns true (no restriction).
 * When set and the IP cannot be determined, returns false (fail-closed).
 */
export async function isRegistrationIpAllowed(): Promise<boolean> {
  const list = process.env.ALLOWED_REGISTRATION_IPS?.trim();
  if (!list) return true;
  const ip = await getClientIp();
  if (!ip) return false;
  return isIPInList(ip, list);
}
