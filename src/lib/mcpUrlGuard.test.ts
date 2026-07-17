// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { assertMcpRemoteUrl, normalizeMcpHeaders } from "./mcpUrlGuard";

afterEach(() => {
  delete process.env.MCP_ALLOW_PRIVATE_URLS;
});

describe("assertMcpRemoteUrl", () => {
  // --- Happy paths ---

  it("accepts https URL", () => {
    const r = assertMcpRemoteUrl("https://example.com/mcp");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.hostname).toBe("example.com");
  });

  it("accepts https with port", () => {
    const r = assertMcpRemoteUrl("https://example.com:8443/sse");
    expect(r.ok).toBe(true);
  });

  // --- Scheme rejections ---

  it("rejects ftp scheme", () => {
    const r = assertMcpRemoteUrl("ftp://example.com/mcp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("scheme");
  });

  it("rejects file scheme", () => {
    const r = assertMcpRemoteUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("scheme");
  });

  it("rejects javascript scheme", () => {
    const r = assertMcpRemoteUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
  });

  it("rejects malformed URL", () => {
    const r = assertMcpRemoteUrl("not-a-url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("invalid");
  });

  it("rejects http without env override", () => {
    const r = assertMcpRemoteUrl("http://example.com/mcp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("MCP_ALLOW_PRIVATE_URLS");
  });

  it("accepts http with env override", () => {
    process.env.MCP_ALLOW_PRIVATE_URLS = "true";
    const r = assertMcpRemoteUrl("http://example.com/mcp");
    expect(r.ok).toBe(true);
  });

  // --- Private IPv4 rejections ---

  it("rejects 127.0.0.1 loopback", () => {
    const r = assertMcpRemoteUrl("https://127.0.0.1/mcp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("private IP");
  });

  it("rejects 10.x private range", () => {
    const r = assertMcpRemoteUrl("https://10.0.0.1/mcp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("private IP");
  });

  it("rejects 192.168.x private range", () => {
    const r = assertMcpRemoteUrl("https://192.168.1.1/mcp");
    expect(r.ok).toBe(false);
  });

  it("rejects 172.16.x private range", () => {
    const r = assertMcpRemoteUrl("https://172.16.0.1/mcp");
    expect(r.ok).toBe(false);
  });

  it("rejects 169.254.169.254 metadata IP", () => {
    const r = assertMcpRemoteUrl("https://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("metadata");
  });

  it("rejects 0.0.0.0", () => {
    const r = assertMcpRemoteUrl("https://0.0.0.0/mcp");
    expect(r.ok).toBe(false);
  });

  it("allows private IPv4 with env override", () => {
    process.env.MCP_ALLOW_PRIVATE_URLS = "true";
    const r = assertMcpRemoteUrl("http://127.0.0.1:3001/mcp");
    expect(r.ok).toBe(true);
  });

  // --- Private IPv6 rejections (with brackets) ---

  it("rejects [::1] IPv6 loopback with brackets", () => {
    const r = assertMcpRemoteUrl("https://[::1]/mcp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("IPv6");
  });

  it("rejects [fe80::1] IPv6 link-local with brackets", () => {
    const r = assertMcpRemoteUrl("https://[fe80::1]/mcp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("IPv6");
  });

  it("rejects [fc00::1] IPv6 unique-local with brackets", () => {
    const r = assertMcpRemoteUrl("https://[fc00::1]/mcp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("IPv6");
  });

  it("allows IPv6 loopback with env override", () => {
    process.env.MCP_ALLOW_PRIVATE_URLS = "true";
    const r = assertMcpRemoteUrl("http://[::1]:3001/mcp");
    expect(r.ok).toBe(true);
  });

  // --- localhost hostname rejections ---

  it("rejects localhost hostname", () => {
    const r = assertMcpRemoteUrl("https://localhost/mcp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("localhost");
  });

  it("allows localhost with env override", () => {
    process.env.MCP_ALLOW_PRIVATE_URLS = "true";
    const r = assertMcpRemoteUrl("http://localhost:3001/mcp");
    expect(r.ok).toBe(true);
  });

  // --- Credentials and query string ---

  it("rejects embedded credentials", () => {
    const r = assertMcpRemoteUrl("https://user:pass@example.com/mcp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("credentials");
  });

  it("rejects query string", () => {
    const r = assertMcpRemoteUrl("https://example.com/mcp?token=secret");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("query");
  });
});

describe("normalizeMcpHeaders", () => {
  it("returns null for null input", () => {
    expect(normalizeMcpHeaders(null)).toBe(null);
  });

  it("returns null for undefined input", () => {
    expect(normalizeMcpHeaders(undefined)).toBe(null);
  });

  it("returns null for empty object", () => {
    expect(normalizeMcpHeaders({})).toBe(null);
  });

  it("trims keys and values", () => {
    const r = normalizeMcpHeaders({ "  Authorization  ": "  Bearer xyz  " });
    expect(r).toEqual({ Authorization: "Bearer xyz" });
  });

  it("drops empty keys", () => {
    const r = normalizeMcpHeaders({ "": "value", Authorization: "Bearer xyz" });
    expect(r).toEqual({ Authorization: "Bearer xyz" });
  });

  it("drops empty values", () => {
    const r = normalizeMcpHeaders({ Authorization: "", "X-Custom": "val" });
    expect(r).toEqual({ "X-Custom": "val" });
  });

  it("drops non-string values", () => {
    const r = normalizeMcpHeaders({ Authorization: "Bearer xyz", Bad: 123 as unknown });
    expect(r).toEqual({ Authorization: "Bearer xyz" });
  });

  it("enforces max value length", () => {
    const longValue = "a".repeat(5000);
    expect(() => normalizeMcpHeaders({ Authorization: longValue })).toThrow();
  });

  it("enforces max entries", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 25; i++) many[`X-Header-${i}`] = "val";
    expect(() => normalizeMcpHeaders(many)).toThrow();
  });

  it("respects custom maxEntries", () => {
    const r = normalizeMcpHeaders({ A: "1", B: "2" }, { maxEntries: 5 });
    expect(r).toEqual({ A: "1", B: "2" });
  });

  it("respects custom maxValueLength", () => {
    expect(() =>
      normalizeMcpHeaders({ A: "aa" }, { maxValueLength: 1 }),
    ).toThrow();
  });
});
