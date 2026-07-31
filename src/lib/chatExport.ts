import { mkdir, appendFile, stat, readdir } from "node:fs/promises";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { logger } from "@/lib/logger";
import { getUserDataRoot } from "@/lib/user-data";
import { convertRichBlocksForExport } from "./richBlockExport";

/** Export mode: "daily" (default) uses date-folder structure; "thread" groups by thread title. */
type ExportMode = "daily" | "thread";

function getExportMode(): ExportMode {
  const raw = (process.env.CHAT_EXPORT_MODE || "daily").trim().toLowerCase();
  return raw === "thread" ? "thread" : "daily";
}
/** Sanitize a thread title for use as a filename. Replaces invalid chars, trims, limits to 80 chars. */
function sanitizeForFilename(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[\x00-\x1f]/g, "")
      .trim()
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

/** Format a Date as "YYYY-MM-DD HH:mm:ss" in local time (respects TZ env). */
function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/** Build the date-based directory path: <basePath>/<YYYY>/<MM>/<DD> (daily mode) */
function buildDateDir(basePath: string, date: Date): string {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return join(basePath, y, m, d);
}

/** Format a Date as "YYYY-MM-DD" (date only, for thread mode filenames). */
function formatDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}



/**
 * Parse a part number from a thread-mode filename.
 * "2026-07-24.md" → 1 (first day, no suffix)
 * "2026-07-27-part2.md" → 2
 * Returns 0 if the filename doesn't match the expected pattern.
 */
function parsePartNumber(filename: string): number {
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(filename)) return 1;
  const m = filename.match(/^\d{4}-\d{2}-\d{2}-part(\d+)\.md$/);
  if (m) return parseInt(m[1], 10);
  return 0;
}

/**
 * In thread mode, resolve the target file for today.
 * - If a file for today's date already exists, return its path (append to it).
 * - If not, find the highest part number used so far, increment by 1, and return the new path.
 *   Part 1 has no "-partN" suffix; parts 2+ use "-partN".
 */
async function resolveThreadFilepath(
  dir: string,
  todayStr: string,
): Promise<string> {
  let maxPart = 0;
  let todayFile: string | null = null;

  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const part = parsePartNumber(entry);
      if (part === 0) continue;
      if (part > maxPart) maxPart = part;
      // Check if this file is for today
      if (entry === `${todayStr}.md` || entry.startsWith(`${todayStr}-part`)) {
        todayFile = join(dir, entry);
      }
    }
  } catch {
    // Directory doesn't exist yet — first write for this thread.
  }

  if (todayFile) return todayFile;

  const nextPart = maxPart + 1;
  const filename =
    nextPart === 1 ? `${todayStr}.md` : `${todayStr}-part${nextPart}.md`;
  return join(dir, filename);
}

/**
 * Resolve a relative export path against the app base directory.
 * Mirrors getDataDir() base-resolution logic from src/lib/user-data.ts.
 * Absolute paths are returned as-is.
 */
function resolveExportPath(rawPath: string): string {
  if (isAbsolute(rawPath)) return rawPath;
  const root = getUserDataRoot();
  if (root) return join(root, rawPath);
  const isCompiled =
    process.execPath.endsWith("minerva.exe") ||
    process.execPath.endsWith("minerva") ||
    process.execPath.endsWith("umanschat.exe") ||
    process.execPath.endsWith("umanschat");
  const base = isCompiled ? dirname(process.execPath) : process.cwd();
  return join(base, rawPath);
}

/**
 * Append a user+assistant message pair to the export file.
 *
 * Two modes (controlled by CHAT_EXPORT_MODE env var):
 * - "daily" (default): <basePath>/<YYYY>/<MM>/<DD>/<title>.md — date-folder structure.
 * - "thread": <basePath>/<title>/<YYYY-MM-DD>[-partN].md — one folder per thread,
 *   with part2, part3... when the thread is resumed on a different day.
 *
 * Creates the directory and file (with title header) on first write.
 * No-ops when CHAT_EXPORT_PATH is empty. All errors are caught and logged — never throws.
 */
export async function appendChatExport(params: {
  threadTitle: string;
  userContent: string;
  assistantContent: string;
}): Promise<void> {
  const rawPath = process.env.CHAT_EXPORT_PATH;
  if (!rawPath || !rawPath.trim()) return;

  try {
    const basePath = resolveExportPath(rawPath.trim());
    const now = new Date();
    const mode = getExportMode();

    let dir: string;
    let filepath: string;

    if (mode === "thread") {
      const sanitized = sanitizeForFilename(params.threadTitle);
      dir = join(basePath, sanitized);
      await mkdir(dir, { recursive: true });
      const todayStr = formatDateOnly(now);
      filepath = await resolveThreadFilepath(dir, todayStr);
    } else {
      dir = buildDateDir(basePath, now);
      await mkdir(dir, { recursive: true });
      const filename = sanitizeForFilename(params.threadTitle) + ".md";
      filepath = join(dir, filename);
    }

    // Check if file already exists to decide whether to write the title header.
    let fileExists = false;
    try {
      await stat(filepath);
      fileExists = true;
    } catch {
      // File does not exist yet — first write.
    }

    const ts = formatTimestamp(now);
    const header = fileExists ? "" : `# ${params.threadTitle}\n`;
    const turnBlock =
      `${header}\n---\n\n## 👤 User (${ts})\n\n${params.userContent}\n\n## 🤖 Assistant (${ts})\n\n${convertRichBlocksForExport(params.assistantContent)}\n`;

    await appendFile(filepath, turnBlock, "utf8");
    logger.info("chat-export", "appended", {
      filepath,
      title: params.threadTitle,
      mode,
    });
  } catch (err) {
    logger.error("chat-export", "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
