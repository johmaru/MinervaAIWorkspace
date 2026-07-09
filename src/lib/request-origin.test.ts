// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  isLocalHostname,
  isLocalOrigin,
  resolvePublicOrigin,
} from "@/lib/request-origin";

describe("isLocalHostname", () => {
  it("returns true for localhost", () => {
    expect(isLocalHostname("localhost")).toBe(true);
  });

  it("returns true for 127.0.0.1", () => {
    expect(isLocalHostname("127.0.0.1")).toBe(true);
  });

  it("returns true for ::1", () => {
    expect(isLocalHostname("::1")).toBe(true);
  });

  it("returns true for *.localhost subdomains", () => {
    expect(isLocalHostname("api.localhost")).toBe(true);
    expect(isLocalHostname("app.localhost")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isLocalHostname("LOCALHOST")).toBe(true);
    expect(isLocalHostname("LocalHost")).toBe(true);
    expect(isLocalHostname("API.LocalHost")).toBe(true);
  });

  it("returns false for public hostnames", () => {
    expect(isLocalHostname("umans.johmaru.jp")).toBe(false);
    expect(isLocalHostname("example.com")).toBe(false);
  });

  it("returns false for non-loopback IPs", () => {
    expect(isLocalHostname("192.168.1.1")).toBe(false);
    expect(isLocalHostname("10.0.0.1")).toBe(false);
  });
});

describe("isLocalOrigin", () => {
  it("returns true for local origins", () => {
    expect(isLocalOrigin("http://localhost:3001")).toBe(true);
    expect(isLocalOrigin("http://127.0.0.1:3001")).toBe(true);
    expect(isLocalOrigin("http://[::1]:3001")).toBe(true);
    expect(isLocalOrigin("http://api.localhost")).toBe(true);
  });

  it("returns false for public origins", () => {
    expect(isLocalOrigin("https://umans.johmaru.jp")).toBe(false);
    expect(isLocalOrigin("https://example.com")).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(isLocalOrigin("not-a-url")).toBe(false);
    expect(isLocalOrigin("")).toBe(false);
  });
});

describe("resolvePublicOrigin", () => {
  it("uses x-forwarded-host + x-forwarded-proto for public access", () => {
    const headers = new Headers({
      "x-forwarded-host": "umans.johmaru.jp",
      "x-forwarded-proto": "https",
    });
    expect(resolvePublicOrigin(headers)).toBe("https://umans.johmaru.jp");
  });

  it("prefers x-forwarded-host over host", () => {
    const headers = new Headers({
      "x-forwarded-host": "umans.johmaru.jp",
      host: "localhost:3001",
      "x-forwarded-proto": "https",
    });
    expect(resolvePublicOrigin(headers)).toBe("https://umans.johmaru.jp");
  });

  it("uses host header when x-forwarded-host is absent (public)", () => {
    const headers = new Headers({
      host: "umans.johmaru.jp",
      "x-forwarded-proto": "https",
    });
    expect(resolvePublicOrigin(headers)).toBe("https://umans.johmaru.jp");
  });

  it("defaults to https when no port and no x-forwarded-proto", () => {
    const headers = new Headers({
      host: "umans.johmaru.jp",
    });
    expect(resolvePublicOrigin(headers)).toBe("https://umans.johmaru.jp");
  });

  it("uses http when host has a non-443 port and no x-forwarded-proto", () => {
    const headers = new Headers({
      host: "umans.johmaru.jp:8080",
    });
    expect(resolvePublicOrigin(headers)).toBe("http://umans.johmaru.jp:8080");
  });

  it("uses https when host port is 443 and no x-forwarded-proto", () => {
    const headers = new Headers({
      host: "umans.johmaru.jp:443",
    });
    expect(resolvePublicOrigin(headers)).toBe("https://umans.johmaru.jp:443");
  });

  it("strips trailing colon from x-forwarded-proto", () => {
    const headers = new Headers({
      "x-forwarded-host": "umans.johmaru.jp",
      "x-forwarded-proto": "https:",
    });
    expect(resolvePublicOrigin(headers)).toBe("https://umans.johmaru.jp");
  });

  it("takes first comma-separated entry from x-forwarded-host", () => {
    const headers = new Headers({
      "x-forwarded-host": "umans.johmaru.jp, example.com",
      "x-forwarded-proto": "https",
    });
    expect(resolvePublicOrigin(headers)).toBe("https://umans.johmaru.jp");
  });

 // Local access paths — present host always wins, even when configured AUTH_URL is public.
 // This is the dual-access guarantee: a local visit stays local and is never
 // bounced to a public origin just because Settings/tunnel saved one.

 it("local host:localhost:3001 with no configured → http://localhost:3001", () => {
   const headers = new Headers({ host: "localhost:3001" });
   expect(resolvePublicOrigin(headers)).toBe("http://localhost:3001");
 });

 it("local host headers + configured public URL → stays local (NOT public)", () => {
   const headers = new Headers({ host: "localhost:3001" });
   expect(
     resolvePublicOrigin(headers, "https://umans.johmaru.jp"),
   ).toBe("http://localhost:3001");
 });

 it("local host headers + configured local URL → local origin", () => {
   const headers = new Headers({ host: "localhost:3001" });
   expect(
     resolvePublicOrigin(headers, "http://localhost:3001"),
   ).toBe("http://localhost:3001");
 });

 it("local 127.0.0.1 host + configured public → stays local", () => {
   const headers = new Headers({ host: "127.0.0.1:3001" });
   expect(
     resolvePublicOrigin(headers, "https://umans.johmaru.jp"),
   ).toBe("http://127.0.0.1:3001");
 });

 it("IPv6 [::1] host treated as local (bracketed hostname)", () => {
   const headers = new Headers({ host: "[::1]:3001" });
   expect(
     resolvePublicOrigin(headers, "https://umans.johmaru.jp"),
   ).toBe("http://[::1]:3001");
 });

  // Missing headers → fall through to configured / default

  it("no headers + configured public → public origin", () => {
    const headers = new Headers();
    expect(
      resolvePublicOrigin(headers, "https://umans.johmaru.jp"),
    ).toBe("https://umans.johmaru.jp");
  });

  it("no headers + no configured → http://localhost:3001", () => {
    const headers = new Headers();
    expect(resolvePublicOrigin(headers)).toBe("http://localhost:3001");
  });

  it("invalid configured URL → default fallback", () => {
    const headers = new Headers({ host: "localhost:3001" });
    expect(resolvePublicOrigin(headers, "not-a-url")).toBe(
      "http://localhost:3001",
    );
  });

  it("null configured URL with local host → default", () => {
    const headers = new Headers({ host: "localhost:3001" });
    expect(resolvePublicOrigin(headers, null)).toBe("http://localhost:3001");
  });
});
