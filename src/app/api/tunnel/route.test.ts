// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the tunnel module: avoid actual cloudflared/Docker operations
vi.mock("@/lib/tunnel", () => ({
  startTunnel: vi.fn().mockResolvedValue(undefined),
  stopTunnel: vi.fn().mockResolvedValue(undefined),
  getTunnelStatus: vi.fn().mockResolvedValue({
    running: false,
    hasToken: false,
    authUrl: "http://localhost:3001",
  }),
}));

// Mock auth-guards: return an authenticated user
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));

// Mock envUtils: avoid actual .env file operations
vi.mock("@/lib/envUtils", () => ({
  resolveEnvPath: vi.fn().mockReturnValue("/tmp/test.env"),
  updateEnvContent: vi.fn().mockReturnValue("TUNNEL_TOKEN=test\nAUTH_URL=https://example.com\n"),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue(""),
  writeFileSync: vi.fn(),
}));

import { POST, GET, DELETE } from "./route";
import { startTunnel, stopTunnel, getTunnelStatus } from "@/lib/tunnel";
import { getSessionUser } from "@/lib/auth-guards";

describe("/api/tunnel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default implementations for each test (reset mockResolvedValue changes)
    vi.mocked(getSessionUser).mockResolvedValue({ id: "test-user-id" });
    vi.mocked(getTunnelStatus).mockResolvedValue({
      running: false,
      hasToken: false,
      authUrl: "http://localhost:3001",
    });
    vi.mocked(startTunnel).mockResolvedValue(undefined);
    vi.mocked(stopTunnel).mockResolvedValue(undefined);
    process.env.TUNNEL_TOKEN = "";
    process.env.AUTH_URL = "http://localhost:3001";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET", () => {
    it("returns tunnel status (token is not returned in plaintext)", async () => {
      vi.mocked(getTunnelStatus).mockResolvedValue({
        running: true,
        hasToken: true,
        authUrl: "https://example.com",
      });

      const res = await GET();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.running).toBe(true);
      expect(data.hasToken).toBe(true);
      expect(data.authUrl).toBe("https://example.com");
      // Token is not included
      expect(data.token).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain("eyJ");
    });

    it("returns 401 when unauthenticated", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(null);

      const res = await GET();
      expect(res.status).toBe(401);
    });
  });

  describe("POST", () => {
    it("starts the tunnel with token + AUTH_URL", async () => {
      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: "test-token-12345",
            authUrl: "https://minerva.example.com",
          }),
        }),
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(startTunnel).toHaveBeenCalledWith("test-token-12345", { force: true });
    });

    it("uses existing process.env when token is not specified", async () => {
      process.env.TUNNEL_TOKEN = "existing-token";

      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authUrl: "https://minerva.example.com",
          }),
        }),
      );

      expect(res.status).toBe(200);
      expect(startTunnel).toHaveBeenCalledWith("existing-token", { force: true });
    });

    it("returns 400 when neither token nor AUTH_URL is specified", async () => {
      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain("TUNNEL_TOKEN");
    });

    it("returns 400 when AUTH_URL does not start with https://", async () => {
      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: "test-token",
            authUrl: "http://example.com",
          }),
        }),
      );
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toContain("https://");
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "invalid json",
        }),
      );

      expect(res.status).toBe(400);
    });

    it("returns 500 error on start failure", async () => {
      vi.mocked(startTunnel).mockRejectedValue(new Error("Docker not found"));

      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: "test-token",
            authUrl: "https://example.com",
          }),
        }),
      );
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.error).toContain("Docker not found");
    });

    it("does not include token in the response", async () => {
      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: "secret-token-abc123",
            authUrl: "https://example.com",
          }),
        }),
      );
      const data = await res.json();
      const dataStr = JSON.stringify(data);

      expect(dataStr).not.toContain("secret-token-abc123");
      expect(dataStr).not.toContain("token");
    });
  });

  describe("DELETE", () => {
    it("stops the tunnel", async () => {
      const res = await DELETE(new Request("http://localhost/api/tunnel", { method: "DELETE" }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(stopTunnel).toHaveBeenCalled();
    });

    it("returns 500 error on stop failure", async () => {
      vi.mocked(stopTunnel).mockRejectedValue(new Error("Stop failed"));

      const res = await DELETE(new Request("http://localhost/api/tunnel", { method: "DELETE" }));
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.error).toContain("Stop failed");
    });
  });
  describe("i18n — locale-aware error messages", () => {
    it("returns English error when locale=en and token is missing", async () => {
      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: "minerva-locale=en" },
          body: JSON.stringify({ authUrl: "https://example.com" }),
        }),
      );
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.error).toBe("TUNNEL_TOKEN is not set");
    });

    it("returns English error when locale=en and AUTH_URL is invalid", async () => {
      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: "minerva-locale=en" },
          body: JSON.stringify({ token: "test-token", authUrl: "http://example.com" }),
        }),
      );
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.error).toBe("AUTH_URL must be a public URL starting with https://");
    });

    it("returns Japanese error when locale=ja and token is missing", async () => {
      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: "minerva-locale=ja" },
          body: JSON.stringify({ authUrl: "https://example.com" }),
        }),
      );
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.error).toBe("TUNNEL_TOKEN が設定されていません");
    });
  });
});
