// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { logger, _flush, _reset, _setLogDirForTest, getLogFilePath } from "@/lib/logger";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Captures console output by replacing console.log/warn/error. */
function captureConsole() {
  const output: { level: string; text: string }[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = (...a: unknown[]) => output.push({ level: "log", text: a.join(" ") });
  console.warn = (...a: unknown[]) => output.push({ level: "warn", text: a.join(" ") });
  console.error = (...a: unknown[]) => output.push({ level: "error", text: a.join(" ") });
  return {
    output,
    restore() {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    },
  };
}

// ── Setup / Teardown ────────────────────────────────────────────────────

let savedEnv: NodeJS.ProcessEnv;
let tmpDir: string;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Redirect file output to a temp dir so tests never touch real data/logs
  tmpDir = mkdtempSync(join(tmpdir(), "minerva-log-test-"));
  _setLogDirForTest(tmpDir);
  // Default: disable file output for most tests
  process.env.LOG_FILE_ENABLED = "false";
  process.env.LOG_LEVEL = "info";
  process.env.LOG_FILE_MAX_SIZE = "5242880";
  _reset();
});

afterEach(async () => {
  await _flush();
  _reset();
  _setLogDirForTest(null);
  process.env = savedEnv;
  // Remove temp dir
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Level Filtering ─────────────────────────────────────────────────────

describe("logger level filtering", () => {
  it("suppresses debug messages when level is info", () => {
    const cap = captureConsole();
    process.env.LOG_LEVEL = "info";
    logger.debug("test", "should not appear");
    logger.info("test", "should appear");
    cap.restore();

    const debugLines = cap.output.filter((o) => o.text.includes("should not appear"));
    const infoLines = cap.output.filter((o) => o.text.includes("should appear"));
    expect(debugLines).toHaveLength(0);
    expect(infoLines).toHaveLength(1);
  });

  it("shows debug messages when level is debug", () => {
    const cap = captureConsole();
    process.env.LOG_LEVEL = "debug";
    logger.debug("test", "debug visible");
    cap.restore();

    const debugLines = cap.output.filter((o) => o.text.includes("debug visible"));
    expect(debugLines).toHaveLength(1);
  });

  it("shows only error when level is error", () => {
    const cap = captureConsole();
    process.env.LOG_LEVEL = "error";
    logger.debug("test", "debug msg");
    logger.info("test", "info msg");
    logger.warn("test", "warn msg");
    logger.error("test", "error msg");
    cap.restore();

    expect(cap.output.filter((o) => o.text.includes("debug msg"))).toHaveLength(0);
    expect(cap.output.filter((o) => o.text.includes("info msg"))).toHaveLength(0);
    expect(cap.output.filter((o) => o.text.includes("warn msg"))).toHaveLength(0);
    expect(cap.output.filter((o) => o.text.includes("error msg"))).toHaveLength(1);
  });

  it("defaults to info when LOG_LEVEL is unset", () => {
    delete process.env.LOG_LEVEL;
    const cap = captureConsole();
    logger.debug("test", "suppressed");
    logger.info("test", "visible");
    cap.restore();

    expect(cap.output.filter((o) => o.text.includes("suppressed"))).toHaveLength(0);
    expect(cap.output.filter((o) => o.text.includes("visible"))).toHaveLength(1);
  });
});

// ── Dynamic Env Read ────────────────────────────────────────────────────

describe("logger dynamic env read", () => {
  it("changes filtering immediately when LOG_LEVEL changes between calls", () => {
    const cap = captureConsole();

    process.env.LOG_LEVEL = "info";
    logger.debug("test", "first debug — suppressed");

    process.env.LOG_LEVEL = "debug";
    logger.debug("test", "second debug — visible");

    process.env.LOG_LEVEL = "warn";
    logger.info("test", "info after change — suppressed");

    cap.restore();

    expect(cap.output.filter((o) => o.text.includes("first debug"))).toHaveLength(0);
    expect(cap.output.filter((o) => o.text.includes("second debug"))).toHaveLength(1);
    expect(cap.output.filter((o) => o.text.includes("info after change"))).toHaveLength(0);
  });
});

// ── Console Output Routing ─────────────────────────────────────────────

describe("logger console routing", () => {
  it("writes info/debug to stdout (console.log)", () => {
    const cap = captureConsole();
    process.env.LOG_LEVEL = "debug";
    logger.info("test", "stdout message");
    logger.debug("test", "debug message");
    cap.restore();

    const stdoutLines = cap.output.filter((o) => o.level === "log");
    expect(stdoutLines.some((o) => o.text.includes("stdout message"))).toBe(true);
    expect(stdoutLines.some((o) => o.text.includes("debug message"))).toBe(true);
  });

  it("writes warn to stderr (console.warn)", () => {
    const cap = captureConsole();
    logger.warn("test", "warn message");
    cap.restore();

    const warnLines = cap.output.filter((o) => o.level === "warn");
    expect(warnLines.some((o) => o.text.includes("warn message"))).toBe(true);
  });

  it("writes error to stderr (console.error)", () => {
    const cap = captureConsole();
    logger.error("test", "error message");
    cap.restore();

    const errLines = cap.output.filter((o) => o.level === "error");
    expect(errLines.some((o) => o.text.includes("error message"))).toBe(true);
  });
});

// ── Format ──────────────────────────────────────────────────────────────

describe("logger format", () => {
  it("produces structured single-line output with ISO timestamp, level, category, message", () => {
    const cap = captureConsole();
    logger.info("mycat", "my message");
    cap.restore();

    const line = cap.output[0].text;
    // [ISO] [level] [category] message
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.Z+-]+\] \[info\] \[mycat\] my message$/);
  });

  it("appends fields as {key=value} pairs", () => {
    const cap = captureConsole();
    logger.info("test", "msg with fields", { a: "1", b: "2" });
    cap.restore();

    expect(cap.output[0].text).toContain("{a=1 b=2}");
  });

  it("serializes Error objects to their message", () => {
    const cap = captureConsole();
    logger.error("test", "err field", { error: new Error("boom") });
    cap.restore();

    expect(cap.output[0].text).toContain("error=boom");
  });
});

// ── File Output ─────────────────────────────────────────────────────────

describe("logger file output", () => {
  it("writes to data/logs/minerva.log when LOG_FILE_ENABLED=true", async () => {
    process.env.LOG_LEVEL = "info";
    process.env.LOG_FILE_ENABLED = "true";
    const logPath = getLogFilePath();

    const cap = captureConsole();
    const marker = `FILE_TEST_${Date.now()}`;
    logger.info("test", marker, { field: "value" });
    await _flush();
    cap.restore();

    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain(marker);
    expect(content).toContain("field=value");
  });

  it("does not write to file when LOG_FILE_ENABLED=false", async () => {
    process.env.LOG_FILE_ENABLED = "false";
    const logPath = getLogFilePath();

    const cap = captureConsole();
    logger.info("test", "should not be in file");
    await _flush();
    cap.restore();

    expect(existsSync(logPath)).toBe(false);
  });
});

// ── Rotation ────────────────────────────────────────────────────────────

describe("logger rotation", () => {
  it("rotates to .log.1 when file exceeds LOG_FILE_MAX_SIZE", async () => {
    process.env.LOG_LEVEL = "info";
    process.env.LOG_FILE_ENABLED = "true";
    // Set max size large enough for several lines but small enough to trigger rotation
    process.env.LOG_FILE_MAX_SIZE = "300";
    const logPath = getLogFilePath();

    _reset();

    const cap = captureConsole();
    // Write enough lines to trigger at least one rotation
    // Each formatted line is ~97 bytes, so 300-byte threshold triggers after ~4 lines
    for (let i = 0; i < 8; i++) {
      logger.info("rottest", `rotation test line ${i} with enough text xxxxxxxx`);
    }
    await _flush();
    cap.restore();

    // After rotation, .log.1 should exist (the old content was renamed)
    expect(existsSync(logPath + ".1")).toBe(true);
    // Current log file should also exist with recent content
    expect(existsSync(logPath)).toBe(true);

    const currentContent = readFileSync(logPath, "utf8");
    const rotatedContent = readFileSync(logPath + ".1", "utf8");

    // No lines should be lost (total across both files)
    const currentLines = currentContent.split("\n").filter((l) => l.trim()).length;
    const rotatedLines = rotatedContent.split("\n").filter((l) => l.trim()).length;
    expect(currentLines + rotatedLines).toBe(8);
  });

  it("no write errors occur during rapid-fire rotation", async () => {
    process.env.LOG_LEVEL = "info";
    process.env.LOG_FILE_ENABLED = "true";
    process.env.LOG_FILE_MAX_SIZE = "100";
    const logPath = getLogFilePath();

    _reset();

    const cap = captureConsole();
    // Rapid-fire 20 lines without awaiting between calls
    for (let i = 0; i < 20; i++) {
      logger.info("rottest", `rapid fire line ${i} with enough text to exceed 100 bytes xxxxxxxx`);
    }
    await _flush();
    cap.restore();

    // Both files should exist (rotation triggered)
    expect(existsSync(logPath)).toBe(true);
    // No lines lost
    const currentContent = readFileSync(logPath, "utf8");
    const rotatedContent = existsSync(logPath + ".1") ? readFileSync(logPath + ".1", "utf8") : "";
    const total = currentContent.split("\n").filter((l) => l.trim()).length +
                  rotatedContent.split("\n").filter((l) => l.trim()).length;
    expect(total).toBe(20);
  });
});

// ── Test Hooks ─────────────────────────────────────────────────────────

describe("logger test hooks", () => {
  it("_reset clears file stream state without hanging", () => {
    process.env.LOG_FILE_ENABLED = "true";
    const cap = captureConsole();
    logger.info("test", "trigger stream creation");
    cap.restore();

    // Should not hang
    _reset();

    // After reset, changing env and writing again should work
    process.env.LOG_FILE_ENABLED = "false";
    const cap2 = captureConsole();
    logger.info("test", "after reset");
    cap2.restore();
    expect(cap2.output.some((o) => o.text.includes("after reset"))).toBe(true);
  });

  it("_flush awaits pending writes to disk", async () => {
    process.env.LOG_FILE_ENABLED = "true";
    const logPath = getLogFilePath();

    const cap = captureConsole();
    logger.info("test", "flush test marker");
    await _flush();
    cap.restore();

    // File should exist and contain the marker immediately after flush
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("flush test marker");
  });

  it("_setLogDirForTest redirects file output to the specified dir", async () => {
    const customDir = mkdtempSync(join(tmpdir(), "custom-log-dir-"));
    _setLogDirForTest(customDir);
    process.env.LOG_FILE_ENABLED = "true";
    const logPath = getLogFilePath();

    const cap = captureConsole();
    logger.info("test", "custom dir marker");
    await _flush();
    cap.restore();

    expect(logPath).toContain(customDir);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("custom dir marker");

    // Cleanup
    _setLogDirForTest(null);
    try { rmSync(customDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
