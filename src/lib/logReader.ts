/**
 * Environment-aware process log reader.
 *
 * Docker environment: queries the Docker Engine API via the unix socket
 *   GET /containers/{id}/logs?stdout=true&stderr=true&tail={tailLines}
 *   where {id} = hostname() (Docker sets hostname = short container ID).
 *   The socket at /var/run/docker.sock is already mounted (docker-compose.yml).
 *
 * exe environment: reads the tail of data/logs/umanschat.log
 *   (path resolved by logger.getLogFilePath()).
 */

import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import * as http from "node:http";
import { getLogFilePath, type LogLevel } from "@/lib/logger";
import { isDockerEnv } from "@/lib/tunnel";

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

  if (isDockerEnv()) {
    try {
      return await readDockerLogs(cappedTail);
    } catch {
      // Docker API failed — fall back to file reader
      return readFileLogs(cappedTail, minLevel);
    }
  }
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

/**
 * Fetch logs from the Docker Engine API via the unix socket.
 * Container ID = hostname() (Docker default). Falls back to listing
 * containers if hostname() doesn't resolve.
 */
async function readDockerLogs(tailLines: number): Promise<LogReadResult> {
  const containerId = hostname();
  let body = await dockerGet(`/containers/${containerId}/logs?stdout=true&stderr=true&tail=${tailLines}`);
  if (body === null) {
    // hostname() didn't match a container — try listing and picking the first
    const listBody = await dockerGet("/containers/json?limit=1");
    if (listBody) {
      try {
        const containers = JSON.parse(listBody.toString("utf8")) as Array<{ Id: string }>;
        if (containers.length > 0) {
          const fallbackId = containers[0].Id;
          body = await dockerGet(`/containers/${fallbackId}/logs?stdout=true&stderr=true&tail=${tailLines}`);
        }
      } catch {
        // JSON parse failed — nothing more we can do
      }
    }
  }
  if (body === null) {
    throw new Error("Docker API request failed (container not found or socket error)");
  }
  const lines = parseDockerLogStream(body);
  return {
    source: "docker",
    lines: lines || "(no log lines returned)",
    truncated: false,
    containerId,
  };
}

/**
 * Send a GET request to the Docker Engine API via the unix socket.
 * Returns null if the request fails (non-200, socket error, or 404).
 */
function dockerGet(path: string): Promise<Buffer | null> {
  const { promise, resolve } = Promise.withResolvers<Buffer | null>();
  const req = http.request(
    {
      socketPath: "/var/run/docker.sock",
      path,
      method: "GET",
      headers: { Host: "localhost" },
      signal: AbortSignal.timeout(5000),
    },
    (res) => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", () => resolve(null));
      } else {
        // Non-OK status (e.g. 404) — consume the body to free the socket
        res.resume();
        resolve(null);
      }
    },
  );
  // AbortSignal.timeout fires as an "error" event with name "TimeoutError"
  req.on("error", () => resolve(null));
  req.end();
  return promise;
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
