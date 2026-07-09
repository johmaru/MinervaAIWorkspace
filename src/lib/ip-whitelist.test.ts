// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// Stub next/headers so we can control what getClientIp sees.
// We mock the module before importing the helper that depends on it.
const headersMock = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    map,
    headers: async () => map,
  };
});

vi.mock("next/headers", () => ({
  headers: headersMock.headers,
}));

import { isRegistrationIpAllowed, getClientIp } from "@/lib/ip-whitelist";

afterEach(() => {
  headersMock.map.clear();
  vi.unstubAllEnvs();
});

describe("getClientIp", () => {
  it("prefers cf-connecting-ip", async () => {
    headersMock.map.set("cf-connecting-ip", "203.0.113.5");
    headersMock.map.set("x-forwarded-for", "198.51.100.1, 10.0.0.1");
    expect(await getClientIp()).toBe("203.0.113.5");
  });

  it("falls back to x-forwarded-for first entry", async () => {
    headersMock.map.set("x-forwarded-for", "198.51.100.1, 10.0.0.1");
    expect(await getClientIp()).toBe("198.51.100.1");
  });

  it("returns null when no relevant headers", async () => {
    expect(await getClientIp()).toBeNull();
  });
});

describe("isRegistrationIpAllowed", () => {
  it("returns true when ALLOWED_REGISTRATION_IPS is unset", async () => {
    vi.stubEnv("ALLOWED_REGISTRATION_IPS", "");
    expect(await isRegistrationIpAllowed()).toBe(true);
  });

  it("returns true when IP is whitelisted (CIDR)", async () => {
    vi.stubEnv("ALLOWED_REGISTRATION_IPS", "10.0.0.0/8");
    headersMock.map.set("cf-connecting-ip", "10.0.0.5");
    expect(await isRegistrationIpAllowed()).toBe(true);
  });

  it("returns false when IP is not whitelisted", async () => {
    vi.stubEnv("ALLOWED_REGISTRATION_IPS", "10.0.0.0/8");
    headersMock.map.set("cf-connecting-ip", "203.0.113.5");
    expect(await isRegistrationIpAllowed()).toBe(false);
  });

  it("returns false (fail-closed) when IP cannot be determined", async () => {
    vi.stubEnv("ALLOWED_REGISTRATION_IPS", "10.0.0.0/8");
    // No headers set → getClientIp returns null → deny
    expect(await isRegistrationIpAllowed()).toBe(false);
  });
});
