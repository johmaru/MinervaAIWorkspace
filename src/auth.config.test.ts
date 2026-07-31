// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock neutralizeAuthUrlForDualAccess so importing auth.config does not
// mutate the real process.env.AUTH_URL at test import time.
vi.mock("@/lib/auth-env", () => ({
  neutralizeAuthUrlForDualAccess: vi.fn(),
}));

import { authConfig } from "@/auth.config";

/** Builds a minimal NextAuth "request" shape for the authorized callback. */
function makeRequest(
  pathname: string,
  headers: Record<string, string> = {},
  origin = "http://localhost:3001",
) {
  const url = new URL(pathname, origin);
  return {
    nextUrl: {
      pathname: url.pathname,
      search: url.search,
      origin: url.origin,
      // authorized only reads pathname + search + origin; provide clones for safety
      clone: () => makeRequest(pathname, headers, origin),
    },
    headers: new Headers(headers),
  } as never;
}

describe("authConfig.callbacks.authorized — dual-access redirects", () => {
  const originalAuthUrl = process.env.AUTH_URL;
  const originalConfigured = process.env.MINERVA_CONFIGURED_AUTH_URL;

  beforeEach(() => {
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;
    delete process.env.MINERVA_CONFIGURED_AUTH_URL;
  });

  afterEach(() => {
    if (originalAuthUrl !== undefined) process.env.AUTH_URL = originalAuthUrl;
    else delete process.env.AUTH_URL;
    if (originalConfigured !== undefined)
      process.env.MINERVA_CONFIGURED_AUTH_URL = originalConfigured;
    else delete process.env.MINERVA_CONFIGURED_AUTH_URL;
  });

  describe("unauthenticated page access", () => {
    it("public x-forwarded-host → redirects to public /login with callbackUrl", async () => {
      const req = makeRequest(
        "/dashboard",
        {
          "x-forwarded-host": "umans.johmaru.jp",
          "x-forwarded-proto": "https",
        },
        "https://umans.johmaru.jp",
      );

      const result = authConfig.callbacks.authorized({
        auth: null,
        request: req,
      } as never);

      expect(result).toBeInstanceOf(Response);
      const res = result as Response;
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      const location = res.headers.get("location")!;
      expect(location).toMatch(/^https:\/\/umans\.johmaru\.jp\/login/);
      expect(location).toContain("callbackUrl=");
      // callbackUrl must encode the public origin
      const cb = new URL(location).searchParams.get("callbackUrl")!;
      expect(cb).toMatch(/^https:\/\/umans\.johmaru\.jp\/dashboard/);
    });

    it("local host:localhost:3001 → redirects to http://localhost:3001/login", async () => {
      const req = makeRequest(
        "/dashboard",
        { host: "localhost:3001" },
        "http://localhost:3001",
      );

      const result = authConfig.callbacks.authorized({
        auth: null,
        request: req,
      } as never);

      const location = (result as Response).headers.get("location")!;
      expect(location).toMatch(/^http:\/\/localhost:3001\/login/);
      const cb = new URL(location).searchParams.get("callbackUrl")!;
      expect(cb).toMatch(/^http:\/\/localhost:3001\/dashboard/);
    });

    it("local host stays local even when public AUTH_URL is configured", async () => {
      process.env.MINERVA_CONFIGURED_AUTH_URL = "https://umans.johmaru.jp";
      const req = makeRequest(
        "/dashboard",
        { host: "localhost:3001" },
        "http://localhost:3001",
      );

      const result = authConfig.callbacks.authorized({
        auth: null,
        request: req,
      } as never);

      const location = (result as Response).headers.get("location")!;
      expect(location).toMatch(/^http:\/\/localhost:3001\/login/);
    });

    it("preserves query string in callbackUrl", async () => {
      const req = makeRequest(
        "/chat?thread=abc",
        {
          "x-forwarded-host": "umans.johmaru.jp",
          "x-forwarded-proto": "https",
        },
        "https://umans.johmaru.jp",
      );

      const result = authConfig.callbacks.authorized({
        auth: null,
        request: req,
      } as never);

      const location = (result as Response).headers.get("location")!;
      const cb = new URL(location).searchParams.get("callbackUrl")!;
      expect(cb).toContain("/chat");
      expect(cb).toContain("thread=abc");
    });
  });

  describe("authenticated user on /login", () => {
    it("redirects to public / when on public host", async () => {
      const req = makeRequest(
        "/login",
        {
          "x-forwarded-host": "umans.johmaru.jp",
          "x-forwarded-proto": "https",
        },
        "https://umans.johmaru.jp",
      );

      const result = authConfig.callbacks.authorized({
        auth: { user: { id: "u1" } } as never,
        request: req,
      } as never);

      expect(result).toBeInstanceOf(Response);
      const location = (result as Response).headers.get("location")!;
      expect(location).toBe("https://umans.johmaru.jp/");
    });

    it("redirects to http://localhost:3001/ when on local host", async () => {
      const req = makeRequest(
        "/login",
        { host: "localhost:3001" },
        "http://localhost:3001",
      );

      const result = authConfig.callbacks.authorized({
        auth: { user: { id: "u1" } } as never,
        request: req,
      } as never);

      const location = (result as Response).headers.get("location")!;
      expect(location).toBe("http://localhost:3001/");
    });

    it("stays local even when public AUTH_URL is configured", async () => {
      process.env.MINERVA_CONFIGURED_AUTH_URL = "https://umans.johmaru.jp";
      const req = makeRequest(
        "/login",
        { host: "localhost:3001" },
        "http://localhost:3001",
      );

      const result = authConfig.callbacks.authorized({
        auth: { user: { id: "u1" } } as never,
        request: req,
      } as never);

      const location = (result as Response).headers.get("location")!;
      expect(location).toBe("http://localhost:3001/");
    });
  });

  describe("authenticated non-login page", () => {
    it("returns true (no redirect)", () => {
      const req = makeRequest(
        "/dashboard",
        { host: "localhost:3001" },
        "http://localhost:3001",
      );

      const result = authConfig.callbacks.authorized({
        auth: { user: { id: "u1" } } as never,
        request: req,
      } as never);

      expect(result).toBe(true);
    });
  });

  describe("unauthenticated /login", () => {
    it("returns true (can view login)", () => {
      const req = makeRequest(
        "/login",
        { host: "localhost:3001" },
        "http://localhost:3001",
      );

      const result = authConfig.callbacks.authorized({
        auth: null,
        request: req,
      } as never);

      expect(result).toBe(true);
    });
  });

  describe("authorized never returns false", () => {
    it("unauthenticated non-login never yields false (always a Response)", () => {
      const req = makeRequest(
        "/",
        { host: "localhost:3001" },
        "http://localhost:3001",
      );

      const result = authConfig.callbacks.authorized({
        auth: null,
        request: req,
      } as never);

      expect(result).not.toBe(false);
      expect(result).toBeInstanceOf(Response);
    });
  });
});
