/**
 * Registration gate logic shared by credentials registration and Google OAuth.
 *
 * Extracted so the Google `signIn` callback's new-user gate can be unit-tested
 * in isolation — the callback itself is embedded in the NextAuth config and
 * not directly importable.
 */
import { isRegistrationIpAllowed } from "./ip-whitelist";

/**
 * Returns true if new account creation is permitted under the current
 * REGISTRATION_LOCKED + ALLOWED_REGISTRATION_IPS settings.
 *
 * - REGISTRATION_LOCKED === "true" → always false (no new accounts)
 * - ALLOWED_REGISTRATION_IPS set and request IP not whitelisted → false
 * - Otherwise → true
 *
 * `existingUser` is whether a user with this email already exists.
 * Existing users bypass these gates (they log in, not register).
 */
export async function canCreateNewAccount(existingUser: boolean): Promise<boolean> {
  if (existingUser) return true;
  if (process.env.REGISTRATION_LOCKED === "true") return false;
  if (!(await isRegistrationIpAllowed())) return false;
  return true;
}
