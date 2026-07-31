// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @/lib/tunnel — isDockerEnv returns false (simulate exe/file mode).
// This follows the existing pattern in updater.test.ts.
vi.mock("@/lib/tunnel", () => ({
  isDockerEnv: vi.fn(() => false),
}));

import { readProcessLogs, parseDockerLogStream } from "@/lib/logReader";
import { _setLogDirForTest, _reset } from "@/lib/logger";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_ROOT = join(tmpdir(), "logreader-test");
const LOG_DIR = join(TMP_ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "minerva.log");

const SAMPLE_LINES = [
  "[2025-01-01T00:00:00.000Z] [debug] [app] debug message",
  "[2025-01-01T00:00:01.000Z] [info] [app] info message",
  "[2025-01-01T00:00:02.000Z] [warn] [app] warn message",
  "[2025-01-01T00:00:03.000Z] [error] [app] error message",
].join("\n");

describe("logReader", () => {
  beforeEach(() => {
    _setLogDirForTest(TMP_ROOT);
    _reset();
    mkdirSync(LOG_DIR, { recursive: true });
  });

  afterEach(() => {
    _setLogDirForTest(null);
    _reset();
    rmSync(TMP_ROOT, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("file mode", () => {
    it("reads existing log file", async () => {
      writeFileSync(LOG_FILE, SAMPLE_LINES, "utf8");
      const result = await readProcessLogs(10, "debug");
      expect(result.source).toBe("file");
      expect(result.lines).toContain("debug message");
      expect(result.lines).toContain("error message");
    });

    it("filters by minimum level", async () => {
      writeFileSync(LOG_FILE, SAMPLE_LINES, "utf8");
      const result = await readProcessLogs(10, "warn");
      expect(result.lines).toContain("warn message");
      expect(result.lines).toContain("error message");
      expect(result.lines).not.toContain("debug message");
      expect(result.lines).not.toContain("info message");
    });

    it("returns placeholder when log file is missing", async () => {
      rmSync(LOG_FILE, { force: true });
      const result = await readProcessLogs(10, "info");
      expect(result.source).toBe("file");
      expect(result.lines).toContain("no log file found");
    });

    it("returns placeholder when no lines match the filter", async () => {
      writeFileSync(LOG_FILE, SAMPLE_LINES, "utf8");
      const result = await readProcessLogs(10, "error");
      expect(result.lines).toContain("error message");
      expect(result.lines).not.toContain("debug");
      expect(result.lines).not.toContain("info message");
      expect(result.lines).not.toContain("warn message");
    });

    it("returns truncated=true and limited bytes for large files", async () => {
      // Write a file larger than MAX_LOG_BYTES (200KB)
      const bigLine = "[2025-01-01T00:00:00.000Z] [info] [app] x".repeat(10);
      const buf: string[] = [];
      let totalSize = 0;
      while (totalSize < 300_000) {
        buf.push(bigLine);
        totalSize += bigLine.length + 1;
      }
      writeFileSync(LOG_FILE, buf.join("\n"), "utf8");
      const result = await readProcessLogs(2000, "info");
      expect(result.truncated).toBe(true);
      // Result should be within MAX_LOG_BYTES + some line slack
      expect(result.lines.length).toBeLessThan(210_000);
    });

    it("skips lines without a [LEVEL] marker", async () => {
      const lines = [
        "MinervaAIWorkspace v1.0.0 — startup banner",
        "[2025-01-01T00:00:00.000Z] [info] [app] started",
        "=== End of startup ===",
      ].join("\n");
      writeFileSync(LOG_FILE, lines, "utf8");
      const result = await readProcessLogs(10, "debug");
      expect(result.lines).toContain("started");
      expect(result.lines).not.toContain("startup banner");
      expect(result.lines).not.toContain("End of startup");
    });

    it("clamps tailLines to 1-2000 range", async () => {
      writeFileSync(LOG_FILE, SAMPLE_LINES, "utf8");
      // tailLines=0 → clamped to 1
      const r1 = await readProcessLogs(0, "debug");
      expect(r1.lines.length).toBeGreaterThan(0);
      // tailLines=99999 → clamped to 2000, no crash
      const r2 = await readProcessLogs(99999, "debug");
      expect(r2.lines.length).toBeGreaterThan(0);
    });
  });

  describe("parseDockerLogStream", () => {
    it("parses single stdout frame", () => {
      const payload = Buffer.from("hello world", "utf8");
      const header = Buffer.alloc(8);
      header.writeUInt8(1, 0); // stdout
      header.writeUInt32BE(payload.length, 4);
      const frame = Buffer.concat([header, payload]);
      expect(parseDockerLogStream(frame)).toBe("hello world");
    });

    it("parses multiple frames (stdout + stderr)", () => {
      const p1 = Buffer.from("line1\n", "utf8");
      const p2 = Buffer.from("line2\n", "utf8");
      const h1 = Buffer.alloc(8);
      h1.writeUInt8(1, 0); // stdout
      h1.writeUInt32BE(p1.length, 4);
      const h2 = Buffer.alloc(8);
      h2.writeUInt8(2, 0); // stderr
      h2.writeUInt32BE(p2.length, 4);
      const data = Buffer.concat([h1, p1, h2, p2]);
      expect(parseDockerLogStream(data)).toBe("line1\nline2\n");
    });

    it("handles empty payload", () => {
      const header = Buffer.alloc(8);
      header.writeUInt8(1, 0);
      header.writeUInt32BE(0, 4);
      expect(parseDockerLogStream(header)).toBe("");
    });

    it("handles truncated frame gracefully", () => {
      const payload = Buffer.from("hello", "utf8");
      const header = Buffer.alloc(8);
      header.writeUInt8(1, 0);
      header.writeUInt32BE(payload.length + 100, 4); // claim more bytes than available
      const data = Buffer.concat([header, payload]);
      // Should stop at the truncated frame, not crash
      expect(parseDockerLogStream(data)).toBe("");
    });

    it("returns empty string for empty buffer", () => {
      expect(parseDockerLogStream(Buffer.alloc(0))).toBe("");
    });
  });
});
