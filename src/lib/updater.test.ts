// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @/lib/tunnel — isDockerEnv returns false (simulate non-Docker),
// httpsDownload and sha256File are stubbed to avoid network/file ops.
vi.mock("@/lib/tunnel", () => ({
  isDockerEnv: vi.fn(() => false),
  httpsDownload: vi.fn(async () => {}),
  sha256File: vi.fn(async () => "fake-hash"),
}));

import {
  compareVersions,
  getAppVersion,
  isExeEnv,
  checkForUpdate,
  downloadUpdate,
  isValidVersion,
} from "@/lib/updater";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "@/lib/user-data";

describe("updater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("compareVersions", () => {
    it("returns 0 for equal versions", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    });

    it("returns 1 when a > b", () => {
      expect(compareVersions("1.2.3", "1.0.0")).toBe(1);
    });

    it("returns -1 when a < b", () => {
      expect(compareVersions("1.0.0", "1.2.3")).toBe(-1);
    });

    it("strips v prefix", () => {
      expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    });

    it("handles different segment counts (1.2 == 1.2.0)", () => {
      expect(compareVersions("1.2", "1.2.0")).toBe(0);
    });

    it("handles major version differences", () => {
      expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    });
  });

  describe("getAppVersion", () => {
    it("reads version from package.json", () => {
      // In test env, process.cwd() is the project root which has package.json
      const version = getAppVersion();
      expect(version).toBe("0.0.0");
    });

    it("returns 0.0.0 on error", () => {
      const original = process.cwd;
      process.cwd = () => "/nonexistent/path";
      try {
        expect(getAppVersion()).toBe("0.0.0");
      } finally {
        process.cwd = original;
      }
    });
  });

  describe("isExeEnv", () => {
    it("returns false in test environment (no minerva.exe in cwd)", () => {
      expect(isExeEnv()).toBe(false);
    });
  });

  describe("checkForUpdate", () => {
    it("returns isExe: false, updateAvailable: false in non-exe env", async () => {
      const info = await checkForUpdate();
      expect(info.isExe).toBe(false);
      expect(info.updateAvailable).toBe(false);
    });

    it("returns updateAvailable: true when GitHub release is newer", async () => {
      // Simulate exe environment: create a temp minerva.exe in cwd
      const exePath = join(process.cwd(), "minerva.exe");
      writeFileSync(exePath, "fake");
      try {
        // Mock fetch to return a newer release
        const mockRelease = {
          tag_name: "v9.9.9",
          body: "New release",
          assets: [
            { name: "MinervaAIWorkspace-9.9.9-windows-x64.zip", browser_download_url: "https://example.com/zip" },
          ],
        };
        vi.stubGlobal("fetch", vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => mockRelease,
        }) as unknown as Response));

        const info = await checkForUpdate();
        expect(info.isExe).toBe(true);
        expect(info.latestVersion).toBe("9.9.9");
        expect(info.updateAvailable).toBe(true);
        expect(info.downloadUrl).toBe("https://example.com/zip");
        expect(info.releaseNotes).toBe("New release");
        expect(info.currentVersion).toBe("0.0.0");
      } finally {
        try { unlinkSync(exePath); } catch {}
        vi.unstubAllGlobals();
      }
    });
  });

  describe("downloadUpdate", () => {
    it("throws in non-exe environment", async () => {
      await expect(
        downloadUpdate("https://example.com/zip", "1.0.0"),
      ).rejects.toThrow("Auto-update is not available in this environment");
    });

    it("uses MINERVA_USER_ROOT/data for update paths when set", () => {
      vi.stubEnv("MINERVA_USER_ROOT", "/custom/user/root");
      const dataDir = getDataDir();
      expect(dataDir).toBe(join("/custom/user/root", "data"));
      expect(join(dataDir, "updates")).toBe(
        join("/custom/user/root", "data", "updates"),
      );
      expect(join(dataDir, ".update-pending")).toBe(
        join("/custom/user/root", "data", ".update-pending"),
      );
    });
  });

  describe("isValidVersion (security)", () => {
    it("accepts valid semver", () => {
      expect(isValidVersion("1.0.0")).toBe(true);
      expect(isValidVersion("0.0.0")).toBe(true);
      expect(isValidVersion("99.99.99")).toBe(true);
    });

    it("rejects version with single quote (shell injection)", () => {
      expect(isValidVersion("1.0.0'; evil-command; '")).toBe(false);
    });

    it("rejects version with path traversal", () => {
      expect(isValidVersion("../../../etc/passwd")).toBe(false);
      expect(isValidVersion("..\\..\\windows")).toBe(false);
    });

    it("rejects version with v-prefix", () => {
      expect(isValidVersion("v1.0.0")).toBe(false);
    });

    it("rejects version with pre-release tag", () => {
      expect(isValidVersion("1.0.0-beta")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isValidVersion("")).toBe(false);
    });

    it("rejects non-numeric segments", () => {
      expect(isValidVersion("a.b.c")).toBe(false);
      expect(isValidVersion("1.0.x")).toBe(false);
    });
  });
});
