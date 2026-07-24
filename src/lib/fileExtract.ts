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
