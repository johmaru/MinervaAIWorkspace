/**
 * Vector search backend abstraction.
 *
 * Allows switching between sqlite-vec (embedded, default) and Qdrant (external)
 * via the VECTOR_BACKEND environment variable.
 *
 * Only kb_chunks (KB search) goes through this abstraction.
 * memories / skills / page_embeddings / user_traits / todos remain on sqlite-vec
 * (small datasets where sqlite-vec performance is sufficient).
 */

import { SqliteVecBackend } from "./vectorBackendSqlite";
import { QdrantBackend } from "./vectorBackendQdrant";

export interface VectorSearchHit {
  id: string;
  text: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

export interface ChunkUpsert {
  id: string;
  text: string;
  embedding: number[];
  ordinal: number;
  contentHash: string;
  documentId: string;
  documentTitle: string;
  sourceType: string;
}

export interface SearchOptions {
  collection: string;
  userId: string;
  kbIds?: string[];
  limit: number;
  threshold: number;
}

export interface VectorBackend {
  /** Search for similar vectors. Returns hits sorted by similarity descending. */
  search(queryVector: number[], options: SearchOptions): Promise<VectorSearchHit[]>;

  /** Store chunk vectors. SqliteVecBackend → db.insert(kbChunks), QdrantBackend → HTTP upsert. */
  upsert(chunks: ChunkUpsert[], options: { userId: string; kbId: string }): Promise<void>;

  /** Delete all chunks for a document. SqliteVecBackend → cascade via kb_documents FK, QdrantBackend → filter delete by document_id. */
  deleteByDocument(documentId: string): Promise<void>;

  /** Delete all chunks for a knowledge base. SqliteVecBackend → cascade via kb_documents FK, QdrantBackend → filter delete by kb_id. */
  deleteByKb(kbId: string): Promise<void>;
}

let backend: VectorBackend | null = null;

/**
 * Returns the configured vector backend.
 * VECTOR_BACKEND=qdrant → QdrantBackend (requires QDRANT_URL)
 * VECTOR_BACKEND=sqlite-vec (default) → SqliteVecBackend
 *
 * The backend is cached after first creation.
 * Call resetVectorBackend() in tests to force re-evaluation.
 */
export function getVectorBackend(): VectorBackend {
  if (!backend) {
    const backendType = process.env.VECTOR_BACKEND || "sqlite-vec";
    if (backendType === "qdrant") {
      backend = new QdrantBackend();
    } else {
      backend = new SqliteVecBackend();
    }
  }
  return backend;
}

/** Reset the cached backend. For tests only. */
export function resetVectorBackend(): void {
  backend = null;
}
