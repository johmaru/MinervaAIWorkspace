/**
 * Process log reader.
 *
 * Reads the tail of data/logs/minerva.log
 * (path resolved by logger.getLogFilePath()).
 * File logging is always enabled (Docker and exe).
 */

import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { getLogFilePath, type LogLevel } from "@/lib/logger";

/** Result returned by readProcessLogs. */
export interface LogReadResult {
  source: "docker" | "file";
  lines: string;
  truncated: boolean;
  containerId?: string; // Docker mode only
}

const MAX_LOG_BYTES = 200_000; // ~200KB cap to stay within tool result token limits

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Read recent process logs.
 *
 * @param tailLines  number of recent lines to retrieve (default 200, capped 1–2000)
 * @param minLevel   minimum log level filter for file mode (default "info")
 */
export async function readProcessLogs(
  tailLines = 200,
  minLevel: LogLevel = "info",
): Promise<LogReadResult> {
  const cappedTail = Math.min(Math.max(tailLines, 1), 2000);

  // Always use file-based log reading. Docker socket is no longer mounted.
  return readFileLogs(cappedTail, minLevel);
}

// ── Docker path ───────────────────────────────────────────────────────

/**
 * Docker Engine API log output is stream-format framed:
 *   [1 byte stream type (1=stdout, 2=stderr)]
 *   [3 bytes reserved/padding]
 *   [4 bytes big-endian uint32 payload length]
 *   [payload bytes (UTF-8)]
 * This parser strips the 8-byte headers and concatenates payloads.
 */
export function parseDockerLogStream(data: Buffer): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > data.length) break; // truncated frame
    parts.push(data.subarray(payloadStart, payloadEnd).toString("utf8"));
    offset = payloadEnd;
  }
  return parts.join("");
}


// ── File path ─────────────────────────────────────────────────────────

/**
 * Read the tail of the log file, applying level filtering.
 */
function readFileLogs(tailLines: number, minLevel: LogLevel): LogReadResult {
  const logPath = getLogFilePath();

  if (!existsSync(logPath)) {
    return {
      source: "file",
      lines: `(no log file found at ${logPath})`,
      truncated: false,
    };
  }

  const stat = statSync(logPath);
  let raw: string;
  let truncated = false;

  if (stat.size > MAX_LOG_BYTES) {
    // Read only the last MAX_LOG_BYTES
    const fd = openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(MAX_LOG_BYTES);
      const bytesRead = readSync(fd, buf, 0, MAX_LOG_BYTES, stat.size - MAX_LOG_BYTES);
      raw = buf.subarray(0, bytesRead).toString("utf8");
      truncated = true;
      // Drop any partial first line (before the first \n)
      const firstNewline = raw.indexOf("\n");
      if (firstNewline >= 0 && firstNewline < raw.length - 1) {
        raw = raw.slice(firstNewline + 1);
      }
    } finally {
      closeSync(fd);
    }
  } else {
    // File is small enough to read entirely
    raw = readFileSync(logPath, "utf8");
  }

  // Split into lines, apply tail + level filter
  const allLines = raw.split("\n").filter((l) => l.length > 0);
  const tailed = allLines.slice(-tailLines);

  const minLevelValue = LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.info;
  const levelRegex = /\[(debug|info|warn|error)\]/i;
  const filtered: string[] = [];

  for (const line of tailed) {
    const match = line.match(levelRegex);
    if (!match) {
      // Lines without a [LEVEL] marker (e.g. startup banners) are skipped
      continue;
    }
    const lineLevel = match[1].toLowerCase() as LogLevel;
    if (LEVEL_ORDER[lineLevel] >= minLevelValue) {
      filtered.push(line);
    }
  }

  return {
    source: "file",
    lines: filtered.length > 0 ? filtered.join("\n") : "(no log lines matched the filter)",
    truncated,
  };
}
