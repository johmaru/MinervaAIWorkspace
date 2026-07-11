// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the updater module: avoid actual GitHub API / file operations
vi.mock("@/lib/updater", () => ({
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
}));

// Mock auth-guards: return an authenticated user by default
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));

import { GET, POST } from "./route";
import { getSessionUser } from "@/lib/auth-guards";
import { checkForUpdate, downloadUpdate } from "@/lib/updater";

describe("/api/update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default implementations
    vi.mocked(getSessionUser).mockResolvedValue({ id: "test-user-id" });
    vi.mocked(checkForUpdate).mockResolvedValue({
      currentVersion: "0.0.0",
      latestVersion: "0.0.0",
      updateAvailable: false,
      downloadUrl: null,
      releaseNotes: null,
      isExe: false,
    });
    vi.mocked(downloadUpdate).mockResolvedValue({
      stagingDir: "/tmp/staging",
      version: "1.0.0",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET", () => {
    it("returns 401 when unauthenticated", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(null);
      const res = await GET();
      expect(res.status).toBe(401);
    });

    it("returns update info when authenticated", async () => {
      vi.mocked(checkForUpdate).mockResolvedValue({
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateAvailable: true,
        downloadUrl: "https://github.com/example/zip",
        releaseNotes: "Release notes",
        isExe: true,
      });

      const res = await GET();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.currentVersion).toBe("1.0.0");
      expect(data.latestVersion).toBe("1.1.0");
      expect(data.updateAvailable).toBe(true);
      expect(data.isExe).toBe(true);
      expect(data.downloadUrl).toBe("https://github.com/example/zip");
    });

    it("returns 500 when checkForUpdate throws", async () => {
      vi.mocked(checkForUpdate).mockRejectedValue(new Error("GitHub API returned 404"));

      const res = await GET();
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.error).toBe("GitHub API returned 404");
    });
  });

  describe("POST", () => {
    it("returns 401 when unauthenticated", async () => {
      vi.mocked(getSessionUser).mockResolvedValue(null);
      const res = await POST(new Request("http://localhost/api/update", {
        method: "POST",
        body: JSON.stringify({ version: "1.0.0" }),
      }));
      expect(res.status).toBe(401);
    });

    it("returns 400 when version is missing", async () => {
      const res = await POST(new Request("http://localhost/api/update", {
        method: "POST",
        body: JSON.stringify({ downloadUrl: "https://example.com" }),
      }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("version");
    });

    it("returns 400 on invalid JSON", async () => {
      const res = await POST(new Request("http://localhost/api/update", {
        method: "POST",
        body: "not json",
      }));
      expect(res.status).toBe(400);
    });

    it("returns 400 when not in exe environment", async () => {
      // Default beforeEach mock has isExe: false
      const res = await POST(new Request("http://localhost/api/update", {
        method: "POST",
        body: JSON.stringify({ version: "1.0.0" }),
      }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("not available");
    });

    it("returns 400 when no update available", async () => {
      vi.mocked(checkForUpdate).mockResolvedValue({
        currentVersion: "1.1.0",
        latestVersion: "1.1.0",
        updateAvailable: false,
        downloadUrl: null,
        releaseNotes: null,
        isExe: true,
      });
      const res = await POST(new Request("http://localhost/api/update", {
        method: "POST",
        body: JSON.stringify({ version: "1.1.0" }),
      }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("No update available");
    });

    it("returns 400 when version does not match latest release", async () => {
      vi.mocked(checkForUpdate).mockResolvedValue({
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateAvailable: true,
        downloadUrl: "https://github.com/example/zip",
        releaseNotes: null,
        isExe: true,
      });
      const res = await POST(new Request("http://localhost/api/update", {
        method: "POST",
        body: JSON.stringify({ version: "1.0.0" }),
      }));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Version mismatch");
    });

    it("returns success when version matches latest release", async () => {
      vi.mocked(checkForUpdate).mockResolvedValue({
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateAvailable: true,
        downloadUrl: "https://github.com/example/zip",
        releaseNotes: null,
        isExe: true,
      });
      vi.mocked(downloadUpdate).mockResolvedValue({
        stagingDir: "/tmp/staging",
        version: "1.1.0",
      });

      const res = await POST(new Request("http://localhost/api/update", {
        method: "POST",
        body: JSON.stringify({ version: "1.1.0" }),
      }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.stagingDir).toBe("/tmp/staging");
      expect(data.version).toBe("1.1.0");
      // Verify downloadUpdate was called with server-verified URL, not client input
      expect(downloadUpdate).toHaveBeenCalledWith("https://github.com/example/zip", "1.1.0");
    });

    it("returns 500 when downloadUpdate throws", async () => {
      vi.mocked(checkForUpdate).mockResolvedValue({
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateAvailable: true,
        downloadUrl: "https://github.com/example/zip",
        releaseNotes: null,
        isExe: true,
      });
      vi.mocked(downloadUpdate).mockRejectedValue(
        new Error("Auto-update is not available in this environment"),
      );

      const res = await POST(new Request("http://localhost/api/update", {
        method: "POST",
        body: JSON.stringify({ version: "1.1.0" }),
      }));
      const data = await res.json();

      expect(res.status).toBe(500);
      expect(data.error).toBe("Auto-update is not available in this environment");
    });

    it("does not pass client downloadUrl to downloadUpdate (SSRF prevention)", async () => {
      vi.mocked(checkForUpdate).mockResolvedValue({
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateAvailable: true,
        downloadUrl: "https://github.com/example/zip",
        releaseNotes: null,
        isExe: true,
      });
      vi.mocked(downloadUpdate).mockResolvedValue({
        stagingDir: "/tmp/staging",
        version: "1.1.0",
      });

      // Client sends a malicious downloadUrl — must be ignored
      await POST(new Request("http://localhost/api/update", {
        method: "POST",
        body: JSON.stringify({
          version: "1.1.0",
          downloadUrl: "http://169.254.169.254/latest/meta-data/",
        }),
      }));

      // downloadUpdate must receive the server-verified URL, not the client's
      expect(downloadUpdate).toHaveBeenCalledWith("https://github.com/example/zip", "1.1.0");
      expect(downloadUpdate).not.toHaveBeenCalledWith(
        "http://169.254.169.254/latest/meta-data/",
        "1.1.0",
      );
    });
  });
});
