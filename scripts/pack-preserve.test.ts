// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stashInstallState,
  restoreInstallState,
  applyExeEnvDefaults,
} from "./pack-preserve";

describe("pack-preserve", () => {
  let base: string;
  let prevOutDir: string;
  let stashDir: string;
  let outDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "packpreserve-"));
    prevOutDir = join(base, "prev");
    stashDir = join(base, "stash");
    outDir = join(base, "out");
    mkdirSync(prevOutDir, { recursive: true });
    mkdirSync(stashDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe("stashInstallState", () => {
    it("copies both .env and data/ when both exist", () => {
      writeFileSync(join(prevOutDir, ".env"), "REGISTRATION_LOCKED=true\n", "utf8");
      mkdirSync(join(prevOutDir, "data"), { recursive: true });
      writeFileSync(join(prevOutDir, "data", "minerva.db"), "db-bytes", "utf8");

      const stashed = stashInstallState(prevOutDir, stashDir);

      expect(stashed).toEqual({ env: true, data: true });
      expect(readFileSync(join(stashDir, ".env"), "utf8")).toBe(
        "REGISTRATION_LOCKED=true\n",
      );
      expect(existsSync(join(stashDir, "data", "minerva.db"))).toBe(true);
    });

    it("copies only .env when data/ is absent", () => {
      writeFileSync(join(prevOutDir, ".env"), "FOO=bar\n", "utf8");

      const stashed = stashInstallState(prevOutDir, stashDir);

      expect(stashed).toEqual({ env: true, data: false });
      expect(readFileSync(join(stashDir, ".env"), "utf8")).toBe("FOO=bar\n");
      expect(existsSync(join(stashDir, "data"))).toBe(false);
    });

    it("copies only data/ when .env is absent", () => {
      mkdirSync(join(prevOutDir, "data"), { recursive: true });
      writeFileSync(join(prevOutDir, "data", "marker.txt"), "marker", "utf8");

      const stashed = stashInstallState(prevOutDir, stashDir);

      expect(stashed).toEqual({ env: false, data: true });
      expect(existsSync(join(stashDir, ".env"))).toBe(false);
      expect(readFileSync(join(stashDir, "data", "marker.txt"), "utf8")).toBe(
        "marker",
      );
    });

    it("copies nothing when neither .env nor data/ exist", () => {
      const stashed = stashInstallState(prevOutDir, stashDir);

      expect(stashed).toEqual({ env: false, data: false });
      expect(existsSync(join(stashDir, ".env"))).toBe(false);
      expect(existsSync(join(stashDir, "data"))).toBe(false);
    });

    it("recursively copies nested data/ tree", () => {
      mkdirSync(join(prevOutDir, "data", "cloudflared"), { recursive: true });
      writeFileSync(join(prevOutDir, "data", "minerva.db"), "db", "utf8");
      writeFileSync(join(prevOutDir, "data", "cloudflared", "binary"), "bin", "utf8");

      const stashed = stashInstallState(prevOutDir, stashDir);

      expect(stashed.data).toBe(true);
      expect(existsSync(join(stashDir, "data", "cloudflared", "binary"))).toBe(true);
      expect(readFileSync(join(stashDir, "data", "minerva.db"), "utf8")).toBe("db");
    });
  });

  describe("restoreInstallState", () => {
    it("overwrites an assembled .env with the stashed user .env", () => {
      // outDir already has an OFT/host-copied .env (unlocked default)
      writeFileSync(join(outDir, ".env"), "REGISTRATION_LOCKED=false\n", "utf8");
      // stash holds the user's live config (locked + IP allowlist + secret)
      writeFileSync(
        join(stashDir, ".env"),
        "REGISTRATION_LOCKED=true\nALLOWED_REGISTRATION_IPS=10.0.0.0/8\nLLM_API_KEY=secret\n",
        "utf8",
      );

      restoreInstallState(stashDir, outDir);

      const restored = readFileSync(join(outDir, ".env"), "utf8");
      expect(restored).toContain("REGISTRATION_LOCKED=true");
      expect(restored).toContain("ALLOWED_REGISTRATION_IPS=10.0.0.0/8");
      expect(restored).toContain("LLM_API_KEY=secret");
      expect(restored).not.toContain("REGISTRATION_LOCKED=false");
    });

    it("restores a stashed data/ tree into outDir", () => {
      mkdirSync(join(stashDir, "data"), { recursive: true });
      writeFileSync(join(stashDir, "data", "marker.txt"), "marker", "utf8");

      restoreInstallState(stashDir, outDir);

      expect(readFileSync(join(outDir, "data", "marker.txt"), "utf8")).toBe(
        "marker",
      );
    });

    it("removes stale outDir/data files when restoring a stashed tree (full replace, not merge)", () => {
      // outDir/data already has a stale file that is NOT in the stashed tree.
      // A merge would leave it; a full-tree replace must delete it.
      mkdirSync(join(outDir, "data"), { recursive: true });
      writeFileSync(join(outDir, "data", "stale.db"), "stale", "utf8");

      mkdirSync(join(stashDir, "data"), { recursive: true });
      writeFileSync(join(stashDir, "data", "fresh.db"), "fresh", "utf8");

      restoreInstallState(stashDir, outDir);

      // Stashed file present
      expect(readFileSync(join(outDir, "data", "fresh.db"), "utf8")).toBe("fresh");
      // Stale file removed (not merged)
      expect(existsSync(join(outDir, "data", "stale.db"))).toBe(false);
    });

    it("is a no-op when stash has neither .env nor data/", () => {
      // outDir has an assembled .env that must remain untouched
      writeFileSync(join(outDir, ".env"), "KEEP=me\n", "utf8");

      restoreInstallState(stashDir, outDir);

      expect(readFileSync(join(outDir, ".env"), "utf8")).toBe("KEEP=me\n");
      expect(existsSync(join(outDir, "data"))).toBe(false);
    });
  });

  describe("applyExeEnvDefaults", () => {
    it("does not clobber security keys but strips Docker service URLs", () => {
      const input = [
        "REGISTRATION_LOCKED=true",
        "ALLOWED_REGISTRATION_IPS=10.0.0.0/8",
        "LLM_MODEL=keep-me",
        "LLM_API_KEY=secret",
        "AUTH_SECRET=abc",
        "EMBED_PROVIDER=sentence-transformers",
        "EMBEDDER_URL=http://embedder:8001",
        "SCRAPER_URL=http://scraper:8000",
        "SEARXNG_URL=http://searxng:8080",
        "DATABASE_URL=postgres://host/db",
      ].join("\n");

      const out = applyExeEnvDefaults(input);

      // Security keys + secrets + LLM preserved untouched
      expect(out).toContain("REGISTRATION_LOCKED=true");
      expect(out).toContain("ALLOWED_REGISTRATION_IPS=10.0.0.0/8");
      expect(out).toContain("LLM_MODEL=keep-me");
      expect(out).toContain("LLM_API_KEY=secret");
      expect(out).toContain("AUTH_SECRET=abc");
      // Docker service hostnames replaced with exe defaults
      expect(out).toContain("EMBED_PROVIDER=local");
      expect(out).toContain("EMBEDDER_URL=");
      expect(out).not.toContain("EMBEDDER_URL=http://embedder:8001");
      expect(out).toContain("SCRAPER_URL=");
      expect(out).not.toContain("SCRAPER_URL=http://scraper:8000");
      expect(out).toContain("SEARXNG_URL=");
      expect(out).not.toContain("SEARXNG_URL=http://searxng:8080");
      expect(out).toContain("DATABASE_URL=data/minerva.db");
      expect(out).not.toContain("DATABASE_URL=postgres://host/db");
    });

    it("does not append missing exe keys (mirrors prior pack-exe behavior)", () => {
      // None of the seven exe keys are present
      const input = "REGISTRATION_LOCKED=true\nLLM_API_KEY=secret\n";

      const out = applyExeEnvDefaults(input);

      // Existing lines preserved
      expect(out).toContain("REGISTRATION_LOCKED=true");
      expect(out).toContain("LLM_API_KEY=secret");
      // Missing exe keys NOT appended (launcher syncEnv adds new example keys)
      expect(out).not.toContain("EMBED_PROVIDER");
      expect(out).not.toContain("SCRAPER_URL");
      expect(out).not.toContain("DATABASE_URL");
    });

    it("sets exe defaults for all seven keys when all are present", () => {
      const input = [
        "EMBED_PROVIDER=other",
        "EMBED_MODEL=other",
        "EMBED_DIM=999",
        "EMBEDDER_URL=http://x:1",
        "SCRAPER_URL=http://y:2",
        "SEARXNG_URL=http://z:3",
        "DATABASE_URL=other",
      ].join("\n");

      const out = applyExeEnvDefaults(input);

      expect(out).toContain("EMBED_PROVIDER=local");
      expect(out).toContain("EMBED_MODEL=Xenova/all-MiniLM-L6-v2");
      expect(out).toContain("EMBED_DIM=384");
      expect(out).toContain("EMBEDDER_URL=");
      expect(out).toContain("SCRAPER_URL=");
      expect(out).toContain("SEARXNG_URL=");
      expect(out).toContain("DATABASE_URL=data/minerva.db");
    });

    it("preserves REGISTRATION_LOCKED=true end-to-end (stash -> restore -> sanitize)", () => {
      // Full pipeline: a locked prior install rebuilt over an OFT-copied host .env.
      writeFileSync(
        join(prevOutDir, ".env"),
        [
          "REGISTRATION_LOCKED=true",
          "ALLOWED_REGISTRATION_IPS=10.0.0.0/8",
          "LLM_MODEL=keep-me",
          "SCRAPER_URL=http://scraper:8000",
        ].join("\n"),
        "utf8",
      );

      const stashed = stashInstallState(prevOutDir, stashDir);
      expect(stashed.env).toBe(true);

      // Simulate assemble: OFT copies a host .env into outDir (unlocked)
      writeFileSync(join(outDir, ".env"), "REGISTRATION_LOCKED=false\n", "utf8");

      restoreInstallState(stashDir, outDir);
      const restored = readFileSync(join(outDir, ".env"), "utf8");
      const sanitized = applyExeEnvDefaults(restored);

      // Lock survives the rebuild
      expect(sanitized).toContain("REGISTRATION_LOCKED=true");
      expect(sanitized).toContain("ALLOWED_REGISTRATION_IPS=10.0.0.0/8");
      expect(sanitized).toContain("LLM_MODEL=keep-me");
      // Docker hostname stripped to exe default
      expect(sanitized).toContain("SCRAPER_URL=");
      expect(sanitized).not.toContain("SCRAPER_URL=http://scraper:8000");
    });
  });
});
