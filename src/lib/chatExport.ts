import { mkdir, appendFile, stat } from "node:fs/promises";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { logger } from "@/lib/logger";
import { getUserDataRoot } from "@/lib/user-data";

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

/** Build the date-based directory path: <basePath>/<YYYY>/<MM>/<DD> */
function buildDateDir(basePath: string, date: Date): string {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return join(basePath, y, m, d);
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
    process.execPath.endsWith("umanschat.exe") ||
    process.execPath.endsWith("umanschat");
  const base = isCompiled ? dirname(process.execPath) : process.cwd();
  return join(base, rawPath);
}

/**
 * Append a user+assistant message pair to the export file.
 * Creates the date folder and file (with title header) on first write.
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
    const dir = buildDateDir(basePath, now);
    await mkdir(dir, { recursive: true });

    const filename = sanitizeForFilename(params.threadTitle) + ".md";
    const filepath = join(dir, filename);

    // Check if file already exists to decide whether to write the title header.
    let fileExists = false;
    try {
      await stat(filepath);
      fileExists = true;
    } catch {
      // File does not exist yet — first write for this day.
    }

    const ts = formatTimestamp(now);
    const header = fileExists ? "" : `# ${params.threadTitle}\n`;
    const turnBlock =
      `${header}\n---\n\n## 👤 User (${ts})\n\n${params.userContent}\n\n## 🤖 Assistant (${ts})\n\n${params.assistantContent}\n`;

    await appendFile(filepath, turnBlock, "utf8");
    logger.info("chat-export", "appended", { filepath, title: params.threadTitle });
  } catch (err) {
    logger.error("chat-export", "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
