/**
 * File text extraction utility.
 *
 * Extracts text from uploaded files (PDF, text-based formats).
 * Shared by /api/upload (message attachments) and /api/knowledge-bases/[id]/documents (KB ingestion).
 *
 * pdf-parse is a heavy CJS module — it is dynamically imported so it stays out
 * of the initial bundle. This is the only place that import lives, so both
 * routes share the same extraction logic without duplicating the cast.
 */

import { readFileSync } from "node:fs";

export type ExtractedFile = {
  text: string;
  /** True if the MIME type was recognized but extraction yielded no text. */
  empty: boolean;
};

/**
 * Extracts text from a File.
 *
 * Supported types:
 * - application/pdf → pdf-parse
 * - text/*, application/json, application/xml → UTF-8
 * - Filename extension fallback: .md, .txt, .json, .csv, .xml, .yml, .yaml,
 *   .ts, .js, .py (for browsers that send application/octet-stream)
 *
 * @throws Error if the file type is unsupported or extraction fails.
 */
const TEXT_EXTENSIONS = [".md", ".txt", ".json", ".csv", ".xml", ".yml", ".yaml", ".ts", ".js", ".py"];

export async function extractFileText(file: File): Promise<ExtractedFile> {
  const mimeType = file.type || "application/octet-stream";
  const filename = file.name.toLowerCase();

  if (mimeType === "application/pdf") {
    const buffer = Buffer.from(await file.arrayBuffer());
    // pdf-parse is CJS with an ambiguous default export shape.
    // Dynamic import keeps this heavy dependency out of the initial bundle.
    const mod: Record<string, unknown> = await import("pdf-parse") as Record<string, unknown>;
    const defaultExport = mod.default;
    const fn = typeof mod === "function"
      ? mod as (buf: Buffer) => Promise<{ text: string }>
      : typeof defaultExport === "function"
        ? defaultExport as (buf: Buffer) => Promise<{ text: string }>
        : null;
    if (!fn) throw new Error("pdf-parse module has no callable export");
    const data = await fn(buffer);
    return { text: data.text || "", empty: data.text.length === 0 };
  }

  if (
    mimeType.startsWith("text/") ||
    mimeType.startsWith("application/json") ||
    mimeType.startsWith("application/xml") ||
    TEXT_EXTENSIONS.some((ext) => filename.endsWith(ext))
  ) {
    const text = await file.text();
    return { text, empty: text.trim().length === 0 };
  }

  throw new Error(`Unsupported file type: ${mimeType}`);
}

/**
 * Extracts text from a file path on disk (for folder ingestion).
 *
 * Same extraction logic as extractFileText but reads from the filesystem
 * instead of a Web File object. PDFs are extracted via pdf-parse;
 * all other non-binary files are read as UTF-8.
 *
 * @param filePath absolute file path on disk
 * @param filename original filename (for extension-based type detection)
 * @throws Error if the file type is unsupported or extraction fails.
 */
export async function extractFileTextFromPath(filePath: string, filename: string): Promise<ExtractedFile> {
  const name = filename.toLowerCase();
  const ext = name.slice(name.lastIndexOf("."));

  if (ext === ".pdf") {
    const buffer = readFileSync(filePath);
    // pdf-parse is CJS with an ambiguous default export shape.
    // Dynamic import keeps this heavy dependency out of the initial bundle.
    const mod: Record<string, unknown> = await import("pdf-parse") as Record<string, unknown>;
    const defaultExport = mod.default;
    const fn = typeof mod === "function"
      ? mod as (buf: Buffer) => Promise<{ text: string }>
      : typeof defaultExport === "function"
        ? defaultExport as (buf: Buffer) => Promise<{ text: string }>
        : null;
    if (!fn) throw new Error("pdf-parse module has no callable export");
    const data = await fn(buffer);
    return { text: data.text || "", empty: data.text.length === 0 };
  }

  // All other files: try reading as UTF-8
  const text = readFileSync(filePath, "utf8");
  return { text, empty: text.trim().length === 0 };
}
