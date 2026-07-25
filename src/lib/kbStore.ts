import { db } from "@/db";
import { knowledgeBases, kbDocuments, kbChunks } from "@/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { embedText, embedTexts, hashContent } from "@/lib/embed";
import { chunkText } from "@/lib/chunker";
import { toVecBuffer, distanceToSimilarity } from "@/lib/vectorSearch";
import { logger } from "@/lib/logger";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep, extname, basename } from "node:path";
import { getWorkspaceRoot, resolveWorkspacePath } from "@/lib/workspace";
import { extractFileTextFromPath } from "@/lib/fileExtract";

/**
 * Knowledge Base store — CRUD for knowledge_bases, document ingestion with
 * chunking + embedding, and RAG search across selected KBs.
 *
 * The embedder (1 container, 1 model) is shared across all KBs via embedText().
 * All chunks use the same EMBED_MODEL/EMBED_DIM, so cross-KB search is possible.
 */

// ── Knowledge Base CRUD ──

export async function listKnowledgeBases(userId: string) {
  return db
    .select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      description: knowledgeBases.description,
      createdAt: knowledgeBases.createdAt,
      updatedAt: knowledgeBases.updatedAt,
      documentCount: sql<number>`(
        SELECT COUNT(*) FROM ${kbDocuments}
        WHERE ${kbDocuments.knowledgeBaseId} = ${knowledgeBases.id}
      )`.as("document_count"),
    })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.userId, userId))
    .orderBy(sql`${knowledgeBases.createdAt} DESC`);
}

export async function createKnowledgeBase(
  userId: string,
  name: string,
  description?: string,
) {
  const [kb] = await db
    .insert(knowledgeBases)
    .values({ userId, name, description: description || null })
    .returning();
  return kb;
}

export async function deleteKnowledgeBase(id: string, userId: string) {
  // Verify ownership before delete
  const [kb] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, id));
  if (!kb) return false;
  // Ownership check via userId on the KB
  const [owned] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(sql`${knowledgeBases.id} = ${id} AND ${knowledgeBases.userId} = ${userId}`);
  if (!owned) return false;
  await db.delete(knowledgeBases).where(eq(knowledgeBases.id, id));
  return true;
}

// ── Document management ──

export async function listDocuments(kbId: string) {
  return db
    .select({
      id: kbDocuments.id,
      title: kbDocuments.title,
      sourceType: kbDocuments.sourceType,
      sourceUrl: kbDocuments.sourceUrl,
      chunkCount: kbDocuments.chunkCount,
      contentHash: kbDocuments.contentHash,
      createdAt: kbDocuments.createdAt,
      updatedAt: kbDocuments.updatedAt,
    })
    .from(kbDocuments)
    .where(eq(kbDocuments.knowledgeBaseId, kbId))
    .orderBy(sql`${kbDocuments.createdAt} DESC`);
}

export type DocumentSource = {
  title: string;
  sourceType: "file" | "url" | "text";
  sourceUrl?: string;
  content: string;
};

/**
 * Ingests a document into a KB: chunks the text, batch-embeds all chunks,
 * and stores them with their embeddings. Returns the document id.
 *
 * If a document with the same contentHash already exists in this KB, returns
 * early (cache hit).
 */
export async function ingestDocument(
  kbId: string,
  source: DocumentSource,
  userId: string,
): Promise<{ id: string; chunkCount: number; cached: boolean }> {
  // Verify KB ownership before ingesting (IDOR prevention)
  const [owned] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(sql`${knowledgeBases.id} = ${kbId} AND ${knowledgeBases.userId} = ${userId}`);
  if (!owned) throw new Error("Knowledge base not found or not owned by user");
  const contentHash = hashContent(source.content);

  // Dedup: check if document with same content already exists in this KB
  const [existing] = await db
    .select({ id: kbDocuments.id })
    .from(kbDocuments)
    .where(
      sql`${kbDocuments.knowledgeBaseId} = ${kbId} AND ${kbDocuments.contentHash} = ${contentHash}`,
    );
  if (existing) {
    return { id: existing.id, chunkCount: 0, cached: true };
  }

  // Chunk the text
  const chunks = chunkText(source.content);
  if (chunks.length === 0) {
    throw new Error("Document content is empty after normalization");
  }

  // Batch-embed all chunks (more efficient than per-chunk calls)
  const vectors = await embedTexts(
    chunks.map((c) => c.text),
    "document",
  );

  const embedModel = process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";

  // Insert document row
  const [doc] = await db
    .insert(kbDocuments)
    .values({
      knowledgeBaseId: kbId,
      title: source.title,
      sourceType: source.sourceType,
      sourceUrl: source.sourceUrl || null,
      content: source.content,
      contentHash,
      chunkCount: chunks.length,
    })
    .returning();

  // Insert all chunks with embeddings
  // Filter out chunks where embedding failed (empty vector)
  const chunkRows = chunks
    .map((chunk, i) => ({
      documentId: doc.id,
      knowledgeBaseId: kbId,
      ordinal: chunk.ordinal,
      text: chunk.text,
      embedding: vectors[i] ?? [],
      contentHash: hashContent(chunk.text),
      model: embedModel,
    }))
    .filter((row) => row.embedding.length > 0);

  if (chunkRows.length === 0) {
    logger.error("kbStore", "all chunk embeddings failed", {
      kbId,
      docId: doc.id,
      title: source.title,
    });
    // Still keep the document row (content is stored), but no searchable chunks
    await db
      .update(kbDocuments)
      .set({ chunkCount: 0 })
      .where(eq(kbDocuments.id, doc.id));
    return { id: doc.id, chunkCount: 0, cached: false };
  }

  // Batch insert chunks
  await db.insert(kbChunks).values(chunkRows);

  return { id: doc.id, chunkCount: chunkRows.length, cached: false };
}

export async function deleteDocument(docId: string, kbId: string) {
  // Verify the document belongs to the specified KB before deleting.
  // Prevents cross-KB deletion via guessed docId (IDOR fix).
  const [doc] = await db
    .select({ id: kbDocuments.id })
    .from(kbDocuments)
    .where(
      sql`${kbDocuments.id} = ${docId} AND ${kbDocuments.knowledgeBaseId} = ${kbId}`,
    );
  if (!doc) return false;
  await db.delete(kbDocuments).where(eq(kbDocuments.id, docId));
  return true;
}

// Extensions to skip (binary/non-text files that can't be meaningfully embedded)
const SKIP_EXTENSIONS: Record<string, true> = {
  ".exe": true, ".dll": true, ".so": true, ".dylib": true, ".bin": true,
  ".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".bmp": true,
  ".ico": true, ".webp": true, ".tiff": true, ".svg": true,
  ".mp3": true, ".mp4": true, ".wav": true, ".avi": true, ".mov": true,
  ".zip": true, ".tar": true, ".gz": true, ".rar": true, ".7z": true,
  ".db": true, ".sqlite": true, ".sqlite3": true,
  ".class": true, ".jar": true, ".war": true, ".pyc": true,
  ".woff": true, ".woff2": true, ".ttf": true, ".otf": true, ".eot": true,
};

/**
 * Recursively scans a folder within the user's workspace and ingests all
 * text-readable files into the specified knowledge base.
 *
 * All file types are eligible except known binary formats (images, audio,
 * video, archives, executables, databases). Binary files are skipped because
 * they cannot be meaningfully chunked or embedded as text.
 *
 * Security: folderPath is resolved against getWorkspaceRoot(userId) with path
 * traversal protection. userId ownership is verified inside ingestDocument.
 *
 * @returns summary of ingested files (count, skipped, errors)
 */
export async function ingestFolder(
  kbId: string,
  folderPath: string,
  userId: string,
): Promise<{ ingested: number; skipped: number; errors: string[] }> {
  const wsRoot = getWorkspaceRoot(userId);
  const absPath = join(wsRoot, folderPath);

  // Path traversal check
  const rel = relative(wsRoot, absPath);
  if (rel.startsWith("..") || (sep === "\\" && rel.includes(".."))) {
    throw new Error(`Path "${folderPath}" is outside the workspace`);
  }

  let stats: { isDirectory: () => boolean };
  try {
    stats = statSync(absPath);
  } catch {
    throw new Error(`Folder not found: ${folderPath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${folderPath}`);
  }

  // Recursively collect all readable files (skip known binary formats)
  const files: string[] = [];
  function scanDir(dir: string) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        // Skip node_modules, .git, and hidden directories
        if (entry === "node_modules" || entry === ".git" || entry.startsWith(".")) continue;
        scanDir(fullPath);
      } else {
        const ext = extname(entry).toLowerCase();
        if (!SKIP_EXTENSIONS[ext]) {
          files.push(fullPath);
        }
      }
    }
  }
  scanDir(absPath);

  let ingested = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const filePath of files) {
    try {
      const extracted = await extractFileTextFromPath(filePath, basename(filePath));
      if (extracted.empty) {
        skipped++;
        continue;
      }
      // Use relative path from workspace root as the document title
      const relPath = relative(wsRoot, filePath).split(sep).join("/");
      await ingestDocument(kbId, {
        title: relPath,
        sourceType: "file",
        content: extracted.text,
      }, userId);
      ingested++;
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ingested, skipped, errors };
}

export type JsonlIngestResult = {
  ingested: number;
  skipped: number;
  cached: number;
  errors: string[];
  /** Sample of ingested titles (up to 10) for the agent to report. */
  titles: string[];
};

/**
 * Bulk-ingest a workspace JSONL file into a knowledge base.
 * Each non-empty line is one JSON object → one document.
 *
 * Supported line shapes (title/content resolved in order of preference):
 * - `{ "title": "...", "content": "..." }`
 * - `{ "name": "...", "content": "..." }`  (title falls back to name)
 * - `{ "character_id": "...", "name": "...", "content": "..." }`
 * - `{ "text": "..." }` with optional title/name
 *
 * Designed for agent RAG builds (e.g. one JSONL line per character) so the
 * model does not need dozens of sequential kb_ingest tool rounds.
 */
export async function ingestJsonlFile(
  kbId: string,
  filePath: string,
  userId: string,
  options?: { maxLines?: number },
): Promise<JsonlIngestResult> {
  const abs = resolveWorkspacePath(filePath, userId);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`JSONL file not found: ${filePath}`);
  }

  const maxLines = Math.min(500, Math.max(1, options?.maxLines ?? 200));
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { ingested: 0, skipped: 0, cached: 0, errors: ["JSONL file is empty"], titles: [] };
  }
  if (lines.length > maxLines) {
    throw new Error(
      `JSONL has ${lines.length} lines (max ${maxLines}). Split the file or raise max_lines.`,
    );
  }

  let ingested = 0;
  let skipped = 0;
  let cached = 0;
  const errors: string[] = [];
  const titles: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      errors.push(`line ${i + 1}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    const content =
      (typeof obj.content === "string" && obj.content) ||
      (typeof obj.text === "string" && obj.text) ||
      (typeof obj.body === "string" && obj.body) ||
      "";
    if (!content.trim()) {
      skipped++;
      continue;
    }

    const title =
      (typeof obj.title === "string" && obj.title.trim()) ||
      (typeof obj.name === "string" && obj.name.trim()) ||
      (typeof obj.character_id === "string" && obj.character_id.trim()) ||
      `${basename(filePath)}#${i + 1}`;

    try {
      const result = await ingestDocument(
        kbId,
        { title, sourceType: "file", sourceUrl: filePath, content },
        userId,
      );
      if (result.cached) cached++;
      else ingested++;
      if (titles.length < 10) titles.push(title);
    } catch (err) {
      errors.push(`line ${i + 1} (${title}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ingested, skipped, cached, errors, titles };
}

// ── RAG search ──

export type KbSearchResult = {
  chunkId: string;
  documentId: string;
  kbId: string;
  text: string;
  similarity: number;
  title: string;
};

/**
 * Searches across the given KB ids for chunks matching the query.
 * Uses sqlite-vec vec_distance_cosine for in-DB similarity computation.
 *
 * Security: joins knowledge_bases to verify userId ownership of each KB,
 * preventing IDOR via client-settable thread.activeKbIds.
 *
 * @param query User's input text
 * @param kbIds Knowledge base ids to search within
 * @param userId Owner's user id — only KBs owned by this user are searched
 * @param limit Max results (default 5)
 * @param threshold Similarity threshold 0-1 (default 0.3 → distance < 0.7)
 */
export async function searchKnowledgeBases(
  query: string,
  kbIds: string[],
  userId: string,
  limit = 5,
  threshold = 0.3,
): Promise<KbSearchResult[]> {
  if (kbIds.length === 0) return [];

  const queryVector = await embedText(query, "query");
  if (queryVector.length === 0) return [];
  const queryBuf = toVecBuffer(queryVector);
  const maxDistance = 1 - threshold;

  const rows = await db.all(sql`
    SELECT kc.id AS chunk_id, kc.document_id, kc.knowledge_base_id,
           kc.text, kc.ordinal,
           d.title AS document_title,
           vec_distance_cosine(kc.embedding, ${queryBuf}) AS distance
    FROM kb_chunks kc
    INNER JOIN kb_documents d ON kc.document_id = d.id
    INNER JOIN knowledge_bases kb ON kc.knowledge_base_id = kb.id
    WHERE kb.user_id = ${userId}
      AND kc.knowledge_base_id IN ${sql.join(
        kbIds.map((id) => sql`${id}`),
        sql`, `,
      )}
      AND vec_distance_cosine(kc.embedding, ${queryBuf}) < ${maxDistance}
    ORDER BY distance
    LIMIT ${limit}
  `) as {
    chunk_id: string;
    document_id: string;
    knowledge_base_id: string;
    text: string;
    ordinal: number;
    document_title: string;
    distance: number;
  }[];

  return rows.map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    kbId: r.knowledge_base_id,
    text: r.text,
    similarity: Number(distanceToSimilarity(r.distance).toFixed(3)),
    title: r.document_title,
  }));
}

/**
 * Builds a system message for chat context injection from KB search results.
 * Called from the chat route's Promise.all alongside buildMemoryContext.
 *
 * Security: userId is passed through to searchKnowledgeBases which joins
 * knowledge_bases.user_id to prevent IDOR via client-settable activeKbIds.
 *
 * @returns system message with relevant KB chunks, or null if no results.
 */
export async function buildKnowledgeContextMessage(
  query: string,
  kbIds: string[],
  userId: string,
): Promise<{ role: "system"; content: string } | null> {
  if (kbIds.length === 0) return null;

  const results = await searchKnowledgeBases(query, kbIds, userId, 5, 0.3);
  if (results.length === 0) return null;

  const chunkLines = results.map(
    (r, i) =>
      `### ${i + 1}. ${r.title} (similarity: ${r.similarity})\n${r.text}`,
  );

  return {
    role: "system",
    content: `The following are relevant excerpts from the user's knowledge bases. Use this information to answer the user's question. If the excerpts don't contain the answer, say so explicitly.\n\n${chunkLines.join("\n\n")}`,
  };
}
