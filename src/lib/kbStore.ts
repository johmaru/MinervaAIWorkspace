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
import {
  expandTokenVariants,
  extractKeywordTokens,
  mergeAndRerankKbHits,
  prefixChunkWithTitle,
  type RankableKbHit,
} from "@/lib/kbSearchRank";
import {
  describeJsonlFilter,
  jsonlLineMatches,
  type JsonlLineFilter,
} from "@/lib/jsonlFilter";
import { writeWorkspaceFile } from "@/lib/workspace";

/** Chunk content and stamp each piece with the document title/speaker when missing. */
function chunkDocument(title: string, content: string): { text: string; ordinal: number }[] {
  return chunkText(content).map((c) => ({
    ordinal: c.ordinal,
    text: prefixChunkWithTitle(title, c.text),
  }));
}

/**
 * Knowledge Base store — CRUD for knowledge_bases, document ingestion with
 * chunking + embedding, and RAG search across selected KBs.
 *
 * The embedder (1 container, 1 model) is shared across all KBs via embedText().
 * All chunks use the same EMBED_MODEL/EMBED_DIM, so cross-KB search is possible.
 */

// ── Knowledge Base CRUD ──

export async function listKnowledgeBases(userId: string) {
  // Correlated COUNT must use raw table/column names. Interpolating drizzle
  // column objects in a subquery can bind values instead of correlating,
  // which made documentCount always 0 in the UI despite documents existing.
  const rows = await db
    .select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      description: knowledgeBases.description,
      createdAt: knowledgeBases.createdAt,
      updatedAt: knowledgeBases.updatedAt,
      documentCount: sql<number>`(
        SELECT COUNT(*) FROM kb_documents
        WHERE kb_documents.knowledge_base_id = knowledge_bases.id
      )`.mapWith(Number),
    })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.userId, userId))
    .orderBy(sql`${knowledgeBases.createdAt} DESC`);
  return rows.map((r) => ({
    ...r,
    documentCount: Number(r.documentCount) || 0,
  }));
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

  // Chunk the text (title stamped on each chunk so multi-chunk docs keep speaker)
  const chunks = chunkDocument(source.title, source.content);
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
 * Performance: chunks all new documents first, then embeds ALL chunk texts in
 * batched HTTP calls (see embedTexts), then inserts. Calling ingestDocument
 * per line used to hammer /embed once per document (thousands of requests) and
 * held the chat SSE open until every embed finished — clients saw "silence"
 * while docker logs flooded with POST /embed.
 *
 * Supported line shapes (title/content resolved in order of preference):
 * - `{ "title": "...", "content": "..." }`
 * - `{ "name": "...", "content": "..." }`  (title falls back to name)
 * - `{ "character_id": "...", "name": "...", "content": "..." }`
 * - `{ "text": "..." }` with optional title/name
 *
 * Optional `filter` (JsonlLineFilter) keeps only matching lines — domain-agnostic
 * field equals/contains (not limited to character dialogue).
 */
export async function ingestJsonlFile(
  kbId: string,
  filePath: string,
  userId: string,
  options?: {
    maxLines?: number;
    /** Keep only lines matching this filter (applied after JSON parse). */
    filter?: JsonlLineFilter;
    /** Progress callback: (docsDone, docsTotal, phase) for SSE status. */
    onProgress?: (done: number, total: number, phase: "parse" | "embed" | "write") => void;
  },
): Promise<JsonlIngestResult> {
  const abs = resolveWorkspacePath(filePath, userId);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`JSONL file not found: ${filePath}`);
  }

  // Conversation-unit RAG can be thousands of lines; default cap is 10k.
  const maxLines = Math.min(20_000, Math.max(1, options?.maxLines ?? 10_000));
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { ingested: 0, skipped: 0, cached: 0, errors: ["JSONL file is empty"], titles: [] };
  }
  if (lines.length > maxLines) {
    throw new Error(
      `JSONL has ${lines.length} lines (max ${maxLines}). Split the file or raise max_lines.`,
    );
  }

  // Ownership once
  const [owned] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(sql`${knowledgeBases.id} = ${kbId} AND ${knowledgeBases.userId} = ${userId}`);
  if (!owned) throw new Error("Knowledge base not found or not owned by user");

  type PendingDoc = {
    lineNo: number;
    title: string;
    content: string;
    contentHash: string;
    chunks: { text: string; ordinal: number }[];
  };

  const pending: PendingDoc[] = [];
  let skipped = 0;
  let cached = 0;
  let filteredOut = 0;
  const errors: string[] = [];
  const titles: string[] = [];
  const filter = options?.filter;

  options?.onProgress?.(0, lines.length, "parse");
  if (filter) {
    logger.info("kbStore", "jsonl-filter", {
      kbId,
      filter: describeJsonlFilter(filter),
      totalLines: lines.length,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      errors.push(`line ${i + 1}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    if (!jsonlLineMatches(obj, filter)) {
      filteredOut++;
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

    const contentHash = hashContent(content);
    const [existing] = await db
      .select({ id: kbDocuments.id })
      .from(kbDocuments)
      .where(
        sql`${kbDocuments.knowledgeBaseId} = ${kbId} AND ${kbDocuments.contentHash} = ${contentHash}`,
      );
    if (existing) {
      cached++;
      if (titles.length < 10) titles.push(title);
      continue;
    }

    const chunks = chunkDocument(title, content);
    if (chunks.length === 0) {
      skipped++;
      continue;
    }

    pending.push({ lineNo: i + 1, title, content, contentHash, chunks });
    if (titles.length < 10) titles.push(title);

    if ((i + 1) % 100 === 0) {
      options?.onProgress?.(i + 1, lines.length, "parse");
    }
  }

  if (pending.length === 0) {
    if (filteredOut > 0 && skipped === 0 && errors.length === 0) {
      errors.push(
        `All ${filteredOut} lines were excluded by filter ${describeJsonlFilter(filter)}`,
      );
    }
    return { ingested: 0, skipped: skipped + filteredOut, cached, errors, titles };
  }

  // Flatten all chunks for one batched embed pipeline
  const flatTexts: string[] = [];
  const flatIndex: { docIdx: number; chunkIdx: number }[] = [];
  for (let d = 0; d < pending.length; d++) {
    const doc = pending[d]!;
    for (let c = 0; c < doc.chunks.length; c++) {
      flatTexts.push(doc.chunks[c]!.text);
      flatIndex.push({ docIdx: d, chunkIdx: c });
    }
  }

  options?.onProgress?.(0, flatTexts.length, "embed");
  logger.info("kbStore", "jsonl-batch-embed-start", {
    kbId,
    docs: pending.length,
    chunks: flatTexts.length,
  });

  // Embed in slices so we can report progress and keep the chat SSE alive.
  // embedTexts also batches HTTP; slicing here is for progress + smaller payloads.
  const allVectors: number[][] = [];
  const EMBED_SLICE = 64;
  for (let i = 0; i < flatTexts.length; i += EMBED_SLICE) {
    const slice = flatTexts.slice(i, i + EMBED_SLICE);
    const vectors = await embedTexts(slice, "document");
    for (let j = 0; j < slice.length; j++) {
      allVectors.push(vectors[j] ?? []);
    }
    options?.onProgress?.(
      Math.min(i + EMBED_SLICE, flatTexts.length),
      flatTexts.length,
      "embed",
    );
  }

  logger.info("kbStore", "jsonl-batch-embed-done", {
    kbId,
    chunks: flatTexts.length,
  });

  // Reassemble vectors per document
  const vectorsByDoc: number[][][] = pending.map(() => []);
  for (let i = 0; i < flatIndex.length; i++) {
    const { docIdx, chunkIdx } = flatIndex[i]!;
    const arr = vectorsByDoc[docIdx]!;
    arr[chunkIdx] = allVectors[i] ?? [];
  }

  const embedModel = process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
  let ingested = 0;

  options?.onProgress?.(0, pending.length, "write");

  for (let d = 0; d < pending.length; d++) {
    const doc = pending[d]!;
    const vectors = vectorsByDoc[d]!;
    try {
      const [row] = await db
        .insert(kbDocuments)
        .values({
          knowledgeBaseId: kbId,
          title: doc.title,
          sourceType: "file",
          sourceUrl: filePath,
          content: doc.content,
          contentHash: doc.contentHash,
          chunkCount: doc.chunks.length,
        })
        .returning();

      const chunkRows = doc.chunks
        .map((chunk, ci) => ({
          documentId: row.id,
          knowledgeBaseId: kbId,
          ordinal: chunk.ordinal,
          text: chunk.text,
          embedding: vectors[ci] ?? [],
          contentHash: hashContent(chunk.text),
          model: embedModel,
        }))
        .filter((r) => r.embedding.length > 0);

      if (chunkRows.length === 0) {
        await db.update(kbDocuments).set({ chunkCount: 0 }).where(eq(kbDocuments.id, row.id));
        errors.push(`line ${doc.lineNo} (${doc.title}): all chunk embeddings failed`);
        continue;
      }

      // Insert chunks in slices to avoid huge multi-row statements
      const SLICE = 50;
      for (let s = 0; s < chunkRows.length; s += SLICE) {
        await db.insert(kbChunks).values(chunkRows.slice(s, s + SLICE));
      }
      if (chunkRows.length !== doc.chunks.length) {
        await db
          .update(kbDocuments)
          .set({ chunkCount: chunkRows.length })
          .where(eq(kbDocuments.id, row.id));
      }
      ingested++;
    } catch (err) {
      errors.push(
        `line ${doc.lineNo} (${doc.title}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if ((d + 1) % 50 === 0 || d + 1 === pending.length) {
      options?.onProgress?.(d + 1, pending.length, "write");
    }
  }

  logger.info("kbStore", "jsonl-ingest-complete", {
    kbId,
    ingested,
    cached,
    skipped,
    filteredOut,
    errors: errors.length,
  });

  return { ingested, skipped: skipped + filteredOut, cached, errors, titles };
}

export type CreateKbFromJsonlResult = {
  kbId: string;
  kbName: string;
  ingest: JsonlIngestResult;
  deletedSameNameKbIds: string[];
  filterDescription: string;
};

/**
 * Generic one-shot: create a knowledge base and bulk-ingest a workspace JSONL,
 * optionally filtered by field equals/contains (any schema — not character-only).
 *
 * Use this for "subset KB" workflows: tag=work, project=foo, name⊃愛, kind=message, etc.
 * Callers that transform domain-specific sources should write JSONL first, then use this.
 */
export async function createKnowledgeBaseFromJsonl(
  userId: string,
  args: {
    name: string;
    description?: string;
    path: string;
    filter?: JsonlLineFilter;
    maxLines?: number;
    /** When true (default), delete existing KBs with the same name first. */
    replaceExisting?: boolean;
    onProgress?: (done: number, total: number, phase: "parse" | "embed" | "write") => void;
  },
): Promise<CreateKbFromJsonlResult> {
  const kbName = args.name.trim();
  if (!kbName) throw new Error("Knowledge base name is required");
  const path = args.path.trim();
  if (!path) throw new Error("JSONL path is required");

  const deletedSameNameKbIds: string[] = [];
  if (args.replaceExisting !== false) {
    const existing = await listKnowledgeBases(userId);
    for (const kb of existing) {
      if (kb.name === kbName) {
        const ok = await deleteKnowledgeBase(kb.id, userId);
        if (ok) deletedSameNameKbIds.push(kb.id);
      }
    }
  }

  const filterDesc = describeJsonlFilter(args.filter);
  const description =
    args.description?.trim() ||
    (args.filter
      ? `From ${path} filtered by ${filterDesc}`
      : `From ${path}`);

  const kb = await createKnowledgeBase(userId, kbName, description);
  const ingest = await ingestJsonlFile(kb.id, path, userId, {
    maxLines: args.maxLines,
    filter: args.filter,
    onProgress: args.onProgress,
  });

  return {
    kbId: kb.id,
    kbName,
    ingest,
    deletedSameNameKbIds,
    filterDescription: filterDesc,
  };
}

/**
 * Write a filtered copy of a workspace JSONL (line-by-line, no full re-schema).
 * Prefer createKnowledgeBaseFromJsonl when the goal is a KB; use this to materialize
 * a subset file for inspection or repeated ingests.
 */
export async function writeFilteredJsonl(
  userId: string,
  sourcePath: string,
  outputPath: string,
  filter: JsonlLineFilter,
): Promise<{ lineCount: number; outputPath: string; bytes: number }> {
  const abs = resolveWorkspacePath(sourcePath, userId);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`JSONL file not found: ${sourcePath}`);
  }
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (jsonlLineMatches(obj, filter)) kept.push(JSON.stringify(obj));
  }
  if (kept.length === 0) {
    throw new Error(
      `No lines matched filter ${describeJsonlFilter(filter)} in ${sourcePath}`,
    );
  }
  const body = kept.join("\n") + "\n";
  await writeWorkspaceFile(outputPath, body, userId);
  return {
    lineCount: kept.length,
    outputPath,
    bytes: Buffer.byteLength(body, "utf8"),
  };
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

type KbSqlRow = {
  chunk_id: string;
  document_id: string;
  knowledge_base_id: string;
  text: string;
  ordinal: number;
  document_title: string;
  distance: number;
};

function rowToHit(r: KbSqlRow): RankableKbHit {
  return {
    chunkId: r.chunk_id,
    documentId: r.document_id,
    kbId: r.knowledge_base_id,
    text: r.text,
    similarity: Number(distanceToSimilarity(r.distance).toFixed(3)),
    title: r.document_title,
  };
}

/**
 * Searches across the given KB ids for chunks matching the query.
 *
 * Hybrid: sqlite-vec cosine recall + keyword LIKE recall, then re-rank with
 * speaker/subject boosts (see kbSearchRank.ts). Pure vector alone mis-attributes
 * character dialogue when the query verb (はまってる) matches a different speaker.
 *
 * Security: joins knowledge_bases to verify userId ownership of each KB,
 * preventing IDOR via client-settable thread.activeKbIds.
 *
 * @param query User's input text
 * @param kbIds Knowledge base ids to search within
 * @param userId Owner's user id — only KBs owned by this user are searched
 * @param limit Max results (default 8)
 * @param threshold Similarity threshold 0-1 (default 0.22 → wider recall for re-rank)
 */
export async function searchKnowledgeBases(
  query: string,
  kbIds: string[],
  userId: string,
  limit = 8,
  threshold = 0.22,
): Promise<KbSearchResult[]> {
  if (kbIds.length === 0) return [];
  const q = query.trim();
  if (!q) return [];

  // IN (...) needs parentheses. Without them SQLite throws: near "?": syntax error
  const kbIdList = sql.join(
    kbIds.map((id) => sql`${id}`),
    sql`, `,
  );

  const vectorHits: RankableKbHit[] = [];
  const queryVector = await embedText(q, "query");
  if (queryVector.length > 0) {
    const queryBuf = toVecBuffer(queryVector);
    // Wider recall for re-ranking (subject boost needs the right speaker in the pool)
    const recallLimit = Math.min(40, Math.max(limit * 5, 20));
    const maxDistance = 1 - threshold;
    const rows = (await db.all(sql`
      SELECT kc.id AS chunk_id, kc.document_id, kc.knowledge_base_id,
             kc.text, kc.ordinal,
             d.title AS document_title,
             vec_distance_cosine(kc.embedding, ${queryBuf}) AS distance
      FROM kb_chunks kc
      INNER JOIN kb_documents d ON kc.document_id = d.id
      INNER JOIN knowledge_bases kb ON kc.knowledge_base_id = kb.id
      WHERE kb.user_id = ${userId}
        AND kc.knowledge_base_id IN (${kbIdList})
        AND vec_distance_cosine(kc.embedding, ${queryBuf}) < ${maxDistance}
      ORDER BY distance
      LIMIT ${recallLimit}
    `)) as KbSqlRow[];
    for (const r of rows) vectorHits.push(rowToHit(r));
  }

  // Keyword path: pull speaker/hobby matches vector search may rank poorly
  const keywordHits: RankableKbHit[] = [];
  const tokens = extractKeywordTokens(q);
  const likePatterns = new Set<string>();
  for (const t of tokens) {
    for (const v of expandTokenVariants(t)) {
      if (v.length >= 1) likePatterns.add(`%${v}%`);
    }
  }
  const patterns = [...likePatterns].slice(0, 12);
  if (patterns.length > 0) {
    const likeClause = sql.join(
      patterns.map((p) => sql`(d.title LIKE ${p} OR kc.text LIKE ${p})`),
      sql` OR `,
    );
    const kwRows = (await db.all(sql`
      SELECT kc.id AS chunk_id, kc.document_id, kc.knowledge_base_id,
             kc.text, kc.ordinal,
             d.title AS document_title,
             0.5 AS distance
      FROM kb_chunks kc
      INNER JOIN kb_documents d ON kc.document_id = d.id
      INNER JOIN knowledge_bases kb ON kc.knowledge_base_id = kb.id
      WHERE kb.user_id = ${userId}
        AND kc.knowledge_base_id IN (${kbIdList})
        AND (${likeClause})
      LIMIT 30
    `)) as KbSqlRow[];
    for (const r of kwRows) {
      keywordHits.push({
        ...rowToHit(r),
        // Keyword-only base similarity (re-rank adds subject boosts)
        similarity: 0.5,
      });
    }
  }

  const merged = mergeAndRerankKbHits(vectorHits, keywordHits, q, limit);
  if (merged.length === 0 && vectorHits.length === 0 && keywordHits.length === 0) {
    return [];
  }

  logger.info("kbStore", "kb-search", {
    queryPreview: q.slice(0, 40),
    vector: vectorHits.length,
    keyword: keywordHits.length,
    returned: merged.length,
  });

  return merged;
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

  const results = await searchKnowledgeBases(query, kbIds, userId, 8, 0.22);
  if (results.length === 0) return null;

  const chunkLines = results.map(
    (r, i) =>
      `### ${i + 1}. ${r.title} (score: ${r.similarity})\n${r.text}`,
  );

  return {
    role: "system",
    content:
      "The following are relevant excerpts from the user's knowledge bases. " +
      "Use them to answer the user's question. " +
      "CRITICAL: Each excerpt title starts with the speaker/character name (before \"|\"). " +
      "Only attribute dialogue to that speaker. If the question names a person, prefer " +
      "excerpts whose title speaker matches that person; do not answer from a different " +
      "character's lines. If none of the matching-speaker excerpts answer the question, " +
      "say so explicitly instead of substituting another character.\n\n" +
      chunkLines.join("\n\n"),
  };
}
