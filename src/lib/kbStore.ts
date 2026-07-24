import { db } from "@/db";
import { knowledgeBases, kbDocuments, kbChunks } from "@/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { embedText, embedTexts, hashContent } from "@/lib/embed";
import { chunkText } from "@/lib/chunker";
import { toVecBuffer, distanceToSimilarity } from "@/lib/vectorSearch";
import { logger } from "@/lib/logger";

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
): Promise<{ id: string; chunkCount: number; cached: boolean }> {
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
