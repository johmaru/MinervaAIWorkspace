/**
 * Lightweight server-only logger module.
 *
 * Features:
 *   - Four levels: debug, info, warn, error (numeric 10/20/30/40)
 *   - Config read at call time from process.env (no stale-config trap)
 *   - Console output always (stdout for info/debug, stderr for warn/error)
 *   - Optional file output to data/logs/umanschat.log (append mode, lazy stream)
 *   - Size-based rotation (one backup: umanschat.log.1)
 *   - Structured single-line format: [ISO] [LEVEL] [category] message {key=val}
 *
 * Env vars (all optional, read at call time):
 *   LOG_LEVEL          — threshold, default "info"
 *   LOG_FILE_ENABLED   — "true"/"false", auto-enabled except when NODE_ENV=test
 *   LOG_FILE_MAX_SIZE  — bytes, default 5242880 (5MB)
 *
 * No external dependencies. Server-side only.
 */

import {
  createWriteStream,
  existsSync,
  statSync,
  renameSync,
  mkdirSync,
  type WriteStream,
} from "node:fs";
import { join, dirname } from "node:path";

// ── Levels ─────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Test-only override for the log directory (avoids touching real data/logs).
let testLogDir: string | null = null;

// ── Environment helpers (inlined to avoid circular dependency) ─────────

/** Determines whether running in a Docker environment. Inlined to avoid circular dependency with tunnel.ts. */
function isDockerEnv(): boolean {
  return process.env.DOCKER_ENV === "true";
}

/**
 * Resolves the app data directory.
 * Mirrors tunnel.ts#getCloudflaredDir(): in the exe environment, resolve from
 * dirname(process.execPath); otherwise from process.cwd().
 * Copied (not imported) to avoid a circular dependency.
 */
function getAppDataDir(): string {
  // Test override: allows tests to redirect file output to a temp dir
  if (testLogDir) return testLogDir;
  const isCompiled =
    process.execPath.endsWith("umanschat.exe") ||
    process.execPath.endsWith("umanschat");
  const appRoot = isCompiled ? dirname(process.execPath) : process.cwd();
  return join(appRoot, "data");
}

/** Resolves the full path to the log file. */
export function getLogFilePath(): string {
  return join(getAppDataDir(), "logs", "umanschat.log");
}

// ── Config (read at call time — no stale-config trap) ──────────────────

function getMinLevel(): number {
  const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  if (envLevel && envLevel in LEVEL_VALUE) return LEVEL_VALUE[envLevel];
  return LEVEL_VALUE.info;
}

function isFileEnabled(): boolean {
  // Tests run with NODE_ENV="test" but some test files (e.g. contextCompaction.test.ts,
  // db/index.test.ts) don't call _setLogDirForTest or set LOG_FILE_ENABLED=false.
  // Without this gate, their logger.error/warn calls contaminate the production log file
  // (data/logs/umanschat.log), producing false-positive corruption/compaction errors
  // that confuse AI self-analysis tools reading the log file later.
  if (process.env.NODE_ENV === "test" && process.env.LOG_FILE_ENABLED !== "true") return false;
  const env = process.env.LOG_FILE_ENABLED;
  if (env === "false") return false;
  return true; // Always enabled in production: Docker (no socket) and exe both need file logs
}

function getMaxFileSize(): number {
  const parsed = parseInt(process.env.LOG_FILE_MAX_SIZE || "", 10);
  if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  return 5_242_880; // 5MB
}

// ── Format ─────────────────────────────────────────────────────────────

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatFields(fields?: Record<string, unknown>): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  const parts = Object.entries(fields).map(
    ([key, val]) => `${key}=${formatValue(val)}`,
  );
  return " {" + parts.join(" ") + "}";
}

function formatLine(
  level: LogLevel,
  category: string,
  message: string,
  fields?: Record<string, unknown>,
): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] [${category}] ${message}${formatFields(fields)}`;
}

// ── File output (lazy WriteStream + async rotation) ───────────────────

let fileStream: WriteStream | null = null;
let currentLogPath: string | null = null;
let bytesWritten = 0;
let rotationPromise: Promise<void> | null = null;
let pendingLines: string[] = [];

function openStream(path: string): WriteStream {
  const stream = createWriteStream(path, { flags: "a" });
  stream.on("error", (err) => {
    // Use raw console — logger itself must not recurse
    console.error("[logger] file stream error:", err.message);
    fileStream = null;
  });
  return stream;
}

function getFileStream(): WriteStream | null {
  if (!isFileEnabled()) return null;
  if (fileStream && !fileStream.destroyed) return fileStream;

  const logPath = getLogFilePath();
  currentLogPath = logPath;
  mkdirSync(dirname(logPath), { recursive: true });
  fileStream = openStream(logPath);
  // Initialize byte count from existing file size (handles pre-existing logs)
  try {
    bytesWritten = statSync(logPath).size;
  } catch {
    bytesWritten = 0;
  }
  return fileStream;
}

/**
 * Performs async rotation: ends the current stream (flushing buffered writes),
 * renames the file, opens a fresh stream, then drains any lines that arrived
 * during rotation. Returns a promise that resolves when rotation is complete.
 * Concurrent calls return the same promise.
 */
function rotate(): Promise<void> {
  if (rotationPromise) return rotationPromise;
  const stream = fileStream;
  const oldPath = currentLogPath;

  rotationPromise = new Promise<void>((resolve) => {
    if (!stream || !oldPath) {
      rotationPromise = null;
      resolve();
      return;
    }
    // end() flushes buffered writes to the OS before the callback fires
    stream.end(() => {
      try {
        renameSync(oldPath, oldPath + ".1");
      } catch {
        // Windows: fd might not be released immediately — skip, retry next rotation
      }
      fileStream = null;
      bytesWritten = 0;
      // Open fresh stream and drain pending lines that arrived during rotation
      const freshStream = getFileStream();
      const queued = pendingLines;
      pendingLines = [];
      if (freshStream) {
        for (const queuedLine of queued) {
          freshStream.write(queuedLine + "\n");
          bytesWritten += Buffer.byteLength(queuedLine, "utf8") + 1;
        }
      }
      rotationPromise = null;
      resolve();
    });
  });
  return rotationPromise;
}

function writeToFile(line: string): void {
  // If rotation is in progress, queue the line — drained after rotation completes
  if (rotationPromise) {
    pendingLines.push(line);
    return;
  }

  const stream = getFileStream();
  if (!stream || !currentLogPath) return;

  const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for \n

  // Rotation: check tracked byte count against limit
  if (bytesWritten + lineBytes > getMaxFileSize()) {
    // Queue this line — it'll be written to the fresh stream after rotation
    pendingLines.push(line);
    rotate();
    return;
  }

  stream.write(line + "\n");
  bytesWritten += lineBytes;
}

// ── Public API ─────────────────────────────────────────────────────────

export function log(
  level: LogLevel,
  category: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_VALUE[level] < getMinLevel()) return;

  const line = formatLine(level, category, message, fields);

  // Console output — always (stdout for debug/info, stderr for warn/error)
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  // File output — when enabled
  writeToFile(line);
}

export const logger = {
  debug: (category: string, message: string, fields?: Record<string, unknown>) =>
    log("debug", category, message, fields),
  info: (category: string, message: string, fields?: Record<string, unknown>) =>
    log("info", category, message, fields),
  warn: (category: string, message: string, fields?: Record<string, unknown>) =>
    log("warn", category, message, fields),
  error: (category: string, message: string, fields?: Record<string, unknown>) =>
    log("error", category, message, fields),
};

// ── Test / reset hooks ─────────────────────────────────────────────────

/**
 * Closes the file stream and waits for all pending writes — including any
 * in-progress rotation — to flush to disk. Sets fileStream to null so the
 * next log line re-opens with current env/path.
 * Intended for tests — not for production use.
 */
export async function _flush(): Promise<void> {
  // Await any in-progress rotation first so pending lines are drained
  if (rotationPromise) {
    await rotationPromise;
  }
  if (!fileStream) return;
  const stream = fileStream;
  fileStream = null;
  currentLogPath = null;
  await new Promise<void>((resolve) => {
    stream.end(() => resolve());
  });
}

/**
 * Forcibly discards all file/rotation state without flushing.
 * Intended for tests when changing env vars that affect the log path.
 * Not for production use.
 */
export function _reset(): void {
  if (fileStream) {
    fileStream.destroy();
    fileStream = null;
    currentLogPath = null;
  }
  rotationPromise = null;
  pendingLines = [];
  bytesWritten = 0;
}

/**
 * Overrides the log directory for tests. Set to a temp dir to avoid
 * touching the real data/logs. Pass null to restore default behavior.
 * Intended for tests — not for production use.
 */
export function _setLogDirForTest(dir: string | null): void {
  testLogDir = dir;
}
