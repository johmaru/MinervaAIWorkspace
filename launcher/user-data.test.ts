// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveUserDataRoot, migrateLegacyData, resolveDataPaths } = require("./user-data.cjs");

describe("launcher/user-data.cjs", () => {
  let base: string;
  let appRoot: string;
  let userDataRoot: string;
  const origUserProfile = process.env.USERPROFILE;
  const origHome = process.env.HOME;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "userdata-"));
    appRoot = join(base, "appRoot");
    userDataRoot = join(base, "userRoot");
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(userDataRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    // Restore env vars — vi.stubEnv doesn't restore automatically for process.env
    if (origUserProfile !== undefined) {
      process.env.USERPROFILE = origUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    vi.restoreAllMocks();
  });

  describe("resolveUserDataRoot", () => {
    it("returns USERPROFILE/.umans_chat_unofficial when USERPROFILE set", () => {
      vi.stubEnv("USERPROFILE", "/test/home");
      expect(resolveUserDataRoot()).toBe(join("/test/home", ".umans_chat_unofficial"));
    });

    it("falls back to HOME when USERPROFILE unset", () => {
      delete process.env.USERPROFILE;
      vi.stubEnv("HOME", "/test/home2");
      expect(resolveUserDataRoot()).toBe(join("/test/home2", ".umans_chat_unofficial"));
    });

    it("throws when neither USERPROFILE nor HOME set", () => {
      delete process.env.USERPROFILE;
      delete process.env.HOME;
      expect(() => resolveUserDataRoot()).toThrow("Cannot determine user home directory");
    });
  });

  describe("migrateLegacyData", () => {
    it("copies legacy .env and data/ when targets absent", () => {
      writeFileSync(join(appRoot, ".env"), "REGISTRATION_LOCKED=true\nLLM_API_KEY=secret\n");
      mkdirSync(join(appRoot, "data"), { recursive: true });
      writeFileSync(join(appRoot, "data", "umanschat.db"), "db-bytes");

      migrateLegacyData(appRoot, userDataRoot);

      expect(readFileSync(join(userDataRoot, ".env"), "utf8")).toBe("REGISTRATION_LOCKED=true\nLLM_API_KEY=secret\n");
      expect(readFileSync(join(userDataRoot, "data", "umanschat.db"), "utf8")).toBe("db-bytes");
    });

    it("skips .env copy when target .env already exists", () => {
      writeFileSync(join(appRoot, ".env"), "OLD=value\n");
      writeFileSync(join(userDataRoot, ".env"), "NEW=value\n");

      migrateLegacyData(appRoot, userDataRoot);

      expect(readFileSync(join(userDataRoot, ".env"), "utf8")).toBe("NEW=value\n");
    });

    it("skips data/ copy when target umanschat.db already exists", () => {
      mkdirSync(join(appRoot, "data"), { recursive: true });
      writeFileSync(join(appRoot, "data", "umanschat.db"), "old-db");
      mkdirSync(join(userDataRoot, "data"), { recursive: true });
      writeFileSync(join(userDataRoot, "data", "umanschat.db"), "new-db");

      migrateLegacyData(appRoot, userDataRoot);

      expect(readFileSync(join(userDataRoot, "data", "umanschat.db"), "utf8")).toBe("new-db");
    });

    it("migrates data/ when target cloudflared/ exists but no DB (partial launch)", () => {
      mkdirSync(join(appRoot, "data"), { recursive: true });
      writeFileSync(join(appRoot, "data", "umanschat.db"), "real-db");
      mkdirSync(join(userDataRoot, "data", "cloudflared"), { recursive: true });

      migrateLegacyData(appRoot, userDataRoot);

      expect(readFileSync(join(userDataRoot, "data", "umanschat.db"), "utf8")).toBe("real-db");
    });

    it("is a no-op when no legacy .env or data/ exist", () => {
      migrateLegacyData(appRoot, userDataRoot);
      expect(existsSync(join(userDataRoot, ".env"))).toBe(false);
      expect(existsSync(join(userDataRoot, "data"))).toBe(false);
    });

    it("copies only .env when legacy data/ is absent", () => {
      writeFileSync(join(appRoot, ".env"), "KEY=val\n");

      migrateLegacyData(appRoot, userDataRoot);

      expect(readFileSync(join(userDataRoot, ".env"), "utf8")).toBe("KEY=val\n");
      expect(existsSync(join(userDataRoot, "data"))).toBe(false);
    });

    it("leaves appRoot intact as backup", () => {
      writeFileSync(join(appRoot, ".env"), "KEY=val\n");
      mkdirSync(join(appRoot, "data"), { recursive: true });
      writeFileSync(join(appRoot, "data", "umanschat.db"), "db");

      migrateLegacyData(appRoot, userDataRoot);

      expect(existsSync(join(appRoot, ".env"))).toBe(true);
      expect(existsSync(join(appRoot, "data", "umanschat.db"))).toBe(true);
    });
  });

  describe("resolveDataPaths", () => {
    it("returns all expected paths under userDataRoot", () => {
      const paths = resolveDataPaths("/custom/root");
      expect(paths.envPath).toBe(join("/custom/root", ".env"));
      expect(paths.dataDir).toBe(join("/custom/root", "data"));
      expect(paths.dbPath).toBe(join("/custom/root", "data", "umanschat.db"));
      expect(paths.cloudflaredDir).toBe(join("/custom/root", "data", "cloudflared"));
      expect(paths.updatesDir).toBe(join("/custom/root", "data", "updates"));
      expect(paths.markerPath).toBe(join("/custom/root", "data", ".update-pending"));
    });
  });
});
