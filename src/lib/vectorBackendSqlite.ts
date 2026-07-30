/**
 * sqlite-vec vector backend.
 *
 * Wraps the existing vec_distance_cosine SQL queries on kb_chunks.
 * This is the default backend (VECTOR_BACKEND=sqlite-vec or unset).
 */

import { db } from "@/db";
import { kbChunks, kbDocuments, knowledgeBases } from "@/db/schema";
import { eq, sql, inArray } from "drizzle-orm";
import { toVecBuffer, distanceToSimilarity } from "@/lib/vectorSearch";
import type { VectorBackend, VectorSearchHit, ChunkUpsert, SearchOptions } from "./vectorBackend";
import { randomUUID } from "node:crypto";

export class SqliteVecBackend implements VectorBackend {
  async search(queryVector: number[], options: SearchOptions): Promise<VectorSearchHit[]> {
    if (!options.kbIds || options.kbIds.length === 0) return [];

    const queryBuf = toVecBuffer(queryVector);
    const kbIdList = sql.join(
      options.kbIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const maxDistance = 1 - options.threshold;

    const rows = (await db.all(sql`
      SELECT kc.id, kc.text, kc.document_id, kc.knowledge_base_id,
             d.title AS document_title,
             vec_distance_cosine(kc.embedding, ${queryBuf}) AS distance
      FROM kb_chunks kc
      INNER JOIN kb_documents d ON kc.document_id = d.id
      INNER JOIN knowledge_bases kb ON kc.knowledge_base_id = kb.id
      WHERE kb.user_id = ${options.userId}
        AND kc.knowledge_base_id IN (${kbIdList})
        AND vec_distance_cosine(kc.embedding, ${queryBuf}) < ${maxDistance}
      ORDER BY distance
      LIMIT ${options.limit}
    `)) as { id: string; text: string; document_id: string; knowledge_base_id: string; document_title: string; distance: number }[];

    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      similarity: distanceToSimilarity(r.distance),
      metadata: {
        documentId: r.document_id,
        documentTitle: r.document_title,
        kb_id: r.knowledge_base_id,
      },
    }));
  }

  async upsert(chunks: ChunkUpsert[], _options: { userId: string; kbId: string }): Promise<void> {
    if (chunks.length === 0) return;

    const rows = chunks.map((c) => ({
      id: c.id,
      knowledgeBaseId: _options.kbId,
      documentId: c.documentId,
      ordinal: c.ordinal,
      text: c.text,
      embedding: c.embedding,
      contentHash: c.contentHash,
      model: process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2",
    }));

    // Insert in slices to avoid huge multi-row statements
    const SLICE = 50;
    for (let i = 0; i < rows.length; i += SLICE) {
      await db.insert(kbChunks).values(rows.slice(i, i + SLICE));
    }
  }

  async deleteByDocument(documentId: string): Promise<void> {
    // kb_chunks has ON DELETE CASCADE via kb_documents FK,
    // so deleting the document row cascades to chunks.
    // This is a no-op here — the caller (kbStore.deleteDocument)
    // already deletes the kb_documents row which triggers the cascade.
    // Kept for interface compliance.
    void documentId;
  }

  async deleteByKb(kbId: string): Promise<void> {
    // kb_chunks has ON DELETE CASCADE via knowledge_bases FK,
    // so deleting the KB row cascades to documents then chunks.
    // This is a no-op here — the caller (kbStore.deleteKnowledgeBase)
    // already deletes the knowledge_bases row which triggers the cascade.
    // Kept for interface compliance.
    void kbId;
  }
}
