import { getSessionUser } from "@/lib/auth-guards";
import {
  listDocuments,
  ingestDocument,
  ingestFolder,
  deleteDocument,
} from "@/lib/kbStore";
import { db } from "@/db";
import { knowledgeBases } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { scrapeUrl } from "@/lib/scraper";
import { extractFileText, extractFileTextFromPath } from "@/lib/fileExtract";
import { resolveWorkspacePath } from "@/lib/workspace";
import { basename } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/knowledge-bases/[id]/documents — List documents in a KB.
 */
export async function GET(req: Request, { params }: Params) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  // Verify ownership
  const [kb] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(sql`${knowledgeBases.id} = ${id} AND ${knowledgeBases.userId} = ${user.id}`);
  if (!kb) return new Response("Not found", { status: 404 });

  const docs = await listDocuments(id);
  return Response.json(docs);
}

type IngestBody = {
  title?: string;
  sourceType?: "file" | "url" | "text" | "workspace_file" | "workspace_folder";
  sourceUrl?: string;
  content?: string;
  workspacePath?: string;
};

/**
 * POST /api/knowledge-bases/[id]/documents — Ingest a document.
 *
 * Accepts two content types:
 * - application/json: { title, sourceType, sourceUrl?, content? }
 *   - sourceType="text": content is required (pasted text)
 *   - sourceType="url": sourceUrl is required; server scrapes the URL to get full content
 * - multipart/form-data: { title, sourceType="file", file: <File> }
 *   - Server extracts text from the uploaded file (PDF via pdf-parse, text/* as UTF-8)
 *
 * The content is chunked (~512 chars, ~64 overlap) and each chunk is embedded.
 * Returns document id + chunk count.
 */
export async function POST(req: Request, { params }: Params) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  // Verify ownership
  const [kb] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(sql`${knowledgeBases.id} = ${id} AND ${knowledgeBases.userId} = ${user.id}`);
  if (!kb) return new Response("Not found", { status: 404 });

  const contentType = req.headers.get("content-type") ?? "";

  let title: string;
  let sourceType: "file" | "url" | "text";
  let sourceUrl: string | undefined;
  let content: string = "";

  if (contentType.includes("multipart/form-data")) {
    // ── File upload path ──
    const formData = await req.formData();
    title = (formData.get("title") as string | null)?.trim() ?? "";
    sourceType = "file";
    const file = formData.get("file") as File | null;
    if (!file) return new Response("file is required", { status: 400 });
    if (file.size > 10 * 1024 * 1024) return new Response("File too large (max 10MB)", { status: 413 });

    try {
      const extracted = await extractFileText(file);
      content = extracted.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "File text extraction failed";
      // Unsupported type → 415, parse failure → 422
      const status = msg.startsWith("Unsupported file type") ? 415 : 422;
      return new Response(msg, { status });
    }
  } else {
    // ── JSON path (text or url) ──
    let body: IngestBody;
    try {
      body = (await req.json()) as IngestBody;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    title = body.title?.trim() ?? "";
    const rawSourceType = body.sourceType ?? "text";
    sourceUrl = body.sourceUrl?.trim();
    const workspacePath = body.workspacePath?.trim();

    if (rawSourceType === "url") {
      // Server-side scrape: get full page content
      if (!sourceUrl) return new Response("sourceUrl is required for url sourceType", { status: 400 });
      const result = await scrapeUrl(sourceUrl);
      if (!result) return new Response("Failed to scrape URL (scraper service unavailable)", { status: 502 });
      content = result.content;
      // Use scraped title if user didn't provide one
      if (!title && result.title) title = result.title;
      sourceType = "url";
    } else if (rawSourceType === "workspace_file") {
      // Read a file from the user's workspace
      if (!workspacePath) return new Response("workspacePath is required for workspace_file sourceType", { status: 400 });
      const absPath = resolveWorkspacePath(workspacePath, user.id);
      try {
        const extracted = await extractFileTextFromPath(absPath, basename(absPath));
        content = extracted.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Workspace file extraction failed";
        return new Response(msg, { status: 422 });
      }
      if (!title) title = workspacePath;
      sourceUrl = workspacePath; // Store path for traceability
      sourceType = "file"; // Normalize to "file" for DB storage
    } else if (rawSourceType === "workspace_folder") {
      // Bulk-ingest a folder from the user's workspace
      if (!workspacePath) return new Response("workspacePath is required for workspace_folder sourceType", { status: 400 });
      try {
        const result = await ingestFolder(id, workspacePath, user.id);
        return Response.json(result, { status: 201 });
      } catch (err) {
        return new Response(err instanceof Error ? err.message : "Folder ingestion failed", { status: 500 });
      }
    } else {
      content = body.content?.trim() ?? "";
      sourceType = "text";
    }
  }

  if (!title) return new Response("title is required", { status: 400 });
  if (!content) return new Response("content is empty (scrape returned no text or file had no extractable text)", { status: 400 });

  try {
    const result = await ingestDocument(id, {
      title,
      sourceType,
      sourceUrl,
      content,
    }, user.id);
    return Response.json(result, { status: 201 });
  } catch (err) {
    return new Response(
      err instanceof Error ? err.message : "Ingestion failed",
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/knowledge-bases/[id]/documents?docId=... — Delete a document.
 * Also deletes all its chunks (cascade).
 */
export async function DELETE(req: Request, { params }: Params) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  // Verify ownership
  const [kb] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(sql`${knowledgeBases.id} = ${id} AND ${knowledgeBases.userId} = ${user.id}`);
  if (!kb) return new Response("Not found", { status: 404 });

  const url = new URL(req.url);
  const docId = url.searchParams.get("docId");
  if (!docId) return new Response("docId query param is required", { status: 400 });

  const deleted = await deleteDocument(docId, id);
  if (!deleted) return new Response("Document not found in this knowledge base", { status: 404 });
  return new Response(null, { status: 204 });
}
