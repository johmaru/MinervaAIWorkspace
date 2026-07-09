// @vitest-environment node
/**
 * Focused test for the signIn callback IP-gate (Step 4b risk item).
 *
 * The Google `signIn` callback in src/auth.ts calls `canCreateNewAccount(false)`
 * before creating a new user. This helper checks REGISTRATION_LOCKED + IP whitelist
 * (which calls `headers()`). This test verifies the actual gate logic the
 * callback relies on, with mocked `headers()`.
 *
 * If `headers()` cannot resolve in the callback context, this test still
 * passes because the mock replaces it. The real question — does `headers()`
 * resolve at runtime in the Auth.js callback — is answered architecturally:
 * the callback runs in the same request AsyncLocalStorage scope as the
 * Next.js Route Handler that invoked Auth.js. `headers()` is a request-time
 * API (confirmed in node_modules/next/dist/docs headers.md) and resolves
 * in any async function called within the request lifecycle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock next/headers — controls what isRegistrationIpAllowed() sees
const headersMock = vi.hoisted(() => {
  const map = new Map<string, string>();
  return { map, headers: async () => map };
});
vi.mock("next/headers", () => ({
  headers: headersMock.headers,
}));

import { canCreateNewAccount } from "@/lib/registration-gate";

afterEach(() => {
  headersMock.map.clear();
  vi.unstubAllEnvs();
});

describe("canCreateNewAccount — the gate the signIn callback calls", () => {
  it("returns false when REGISTRATION_LOCKED is true (new user)", async () => {
    vi.stubEnv("REGISTRATION_LOCKED", "true");
    vi.stubEnv("ALLOWED_REGISTRATION_IPS", "");
    expect(await canCreateNewAccount(false)).toBe(false);
  });

  it("returns false when IP is not whitelisted", async () => {
    vi.stubEnv("REGISTRATION_LOCKED", "false");
    vi.stubEnv("ALLOWED_REGISTRATION_IPS", "10.0.0.0/8");
    headersMock.map.set("cf-connecting-ip", "203.0.113.5");
    // This calls headers() → isRegistrationIpAllowed() → isIPInList()
    // If headers() didn't resolve, this would throw or return wrong value
    expect(await canCreateNewAccount(false)).toBe(false);
  });

  it("returns true when IP is whitelisted", async () => {
    vi.stubEnv("REGISTRATION_LOCKED", "false");
    vi.stubEnv("ALLOWED_REGISTRATION_IPS", "10.0.0.0/8");
    headersMock.map.set("cf-connecting-ip", "10.0.0.5");
    expect(await canCreateNewAccount(false)).toBe(true);
  });

  it("returns true when no restrictions are set", async () => {
    vi.stubEnv("REGISTRATION_LOCKED", "false");
    vi.stubEnv("ALLOWED_REGISTRATION_IPS", "");
    expect(await canCreateNewAccount(false)).toBe(true);
  });

  it("returns true for existing users (bypasses all gates)", async () => {
    vi.stubEnv("REGISTRATION_LOCKED", "true");
    vi.stubEnv("ALLOWED_REGISTRATION_IPS", "10.0.0.0/8");
    // No headers set — would fail-closed for new users, but existing users bypass
    expect(await canCreateNewAccount(true)).toBe(true);
  });

  it("returns false (fail-closed) when IP cannot be determined and whitelist is set", async () => {
    vi.stubEnv("REGISTRATION_LOCKED", "false");
    vi.stubEnv("ALLOWED_REGISTRATION_IPS", "10.0.0.0/8");
    // No headers set → getClientIp returns null → deny
    expect(await canCreateNewAccount(false)).toBe(false);
  });
});
