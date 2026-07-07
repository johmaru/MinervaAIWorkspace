// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// tunnel モジュールをモック: 実際の cloudflared/Docker 操作を行わない
vi.mock("@/lib/tunnel", () => ({
  startTunnel: vi.fn().mockResolvedValue(undefined),
  stopTunnel: vi.fn().mockResolvedValue(undefined),
  getTunnelStatus: vi.fn().mockResolvedValue({
    running: false,
    hasToken: false,
    authUrl: "http://localhost:3001",
  }),
}));

// auth-guards をモック: 認証済みユーザーを返す
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));

// envUtils をモック: 実際の .env ファイル操作を行わない
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
    // 各テストでデフォルト実装を再設定（mockResolvedValue の変更をリセット）
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
    it("トンネル状態を返す（トークンは平文で返さない）", async () => {
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
      // トークンは含まれない
      expect(data.token).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain("eyJ");
    });

    it("未認証は 401", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(null);

      const res = await GET();
      expect(res.status).toBe(401);
    });
  });

  describe("POST", () => {
    it("トークン + AUTH_URL でトンネルを起動", async () => {
      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: "test-token-12345",
            authUrl: "https://umanschat.example.com",
          }),
        }),
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(startTunnel).toHaveBeenCalledWith("test-token-12345", { force: true });
    });

    it("トークン未指定時は既存 process.env を使用", async () => {
      process.env.TUNNEL_TOKEN = "existing-token";

      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authUrl: "https://umanschat.example.com",
          }),
        }),
      );

      expect(res.status).toBe(200);
      expect(startTunnel).toHaveBeenCalledWith("existing-token", { force: true });
    });

    it("トークンも AUTH_URL も未指定は 400", async () => {
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

    it("AUTH_URL が https:// でない場合は 400", async () => {
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

    it("無効な JSON は 400", async () => {
      const res = await POST(
        new Request("http://localhost/api/tunnel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "invalid json",
        }),
      );

      expect(res.status).toBe(400);
    });

    it("起動失敗時は 500 エラー", async () => {
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

    it("レスポンスにトークンを含めない", async () => {
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
    it("トンネルを停止", async () => {
      const res = await DELETE();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(stopTunnel).toHaveBeenCalled();
    });

    it("停止失敗時は 500 エラー", async () => {
      vi.mocked(stopTunnel).mockRejectedValue(new Error("Stop failed"));

      const res = await DELETE();
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.error).toContain("Stop failed");
    });
  });
});
