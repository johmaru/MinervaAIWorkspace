/**
 * Qdrant vector backend.
 *
 * Connects to an external Qdrant instance via REST API.
 * Requires VECTOR_BACKEND=qdrant, QDRANT_URL, and optionally QDRANT_API_KEY.
 *
 * Multi-user isolation: all points carry a user_id payload field with a
 * payload index, so search queries filter by user_id.
 */

import { logger } from "@/lib/logger";
import { hashContent } from "@/lib/embed";
import type { VectorBackend, VectorSearchHit, ChunkUpsert, SearchOptions } from "./vectorBackend";

interface QdrantHit {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

const COLLECTION = "umanschat_kb";

export class QdrantBackend implements VectorBackend {
  private url: string;
  private apiKey?: string;
  private collectionEnsured = false;

  constructor() {
    this.url = (process.env.QDRANT_URL || "http://localhost:6333").replace(/\/$/, "");
    this.apiKey = process.env.QDRANT_API_KEY || undefined;
  }

  /** Lazily create the collection + payload indexes on first use. */
  private async ensureCollection(): Promise<void> {
    if (this.collectionEnsured) return;

    const checkRes = await fetch(`${this.url}/collections/${COLLECTION}`, {
      headers: this.headers(),
    });
    if (checkRes.ok) {
      this.collectionEnsured = true;
      return;
    }
    if (checkRes.status !== 404) {
      throw new Error(`Qdrant collection check failed: ${checkRes.status}`);
    }

    // Collection doesn't exist — create it
    const embedDim = Number(process.env.EMBED_DIM) || 768;
    logger.info("qdrant", "creating collection", { collection: COLLECTION, dim: embedDim });
    const createRes = await fetch(`${this.url}/collections/${COLLECTION}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        vectors: { size: embedDim, distance: "Cosine" },
        optimizers_config: { indexing_threshold: 20000 },
      }),
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => "");
      throw new Error(`Failed to create Qdrant collection: ${createRes.status} ${text.slice(0, 200)}`);
    }

    // Create payload indexes for filter performance
    for (const field of ["user_id", "kb_id", "document_id"]) {
      await fetch(`${this.url}/collections/${COLLECTION}/index`, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
      });
    }
    logger.info("qdrant", "collection ready", { collection: COLLECTION });
    this.collectionEnsured = true;
  }

  async search(queryVector: number[], options: SearchOptions): Promise<VectorSearchHit[]> {
    const body: Record<string, unknown> = {
      vector: queryVector,
      limit: options.limit,
      with_payload: true,
      score_threshold: options.threshold,
    };

    const must: Record<string, unknown>[] = [
      { key: "user_id", match: { value: options.userId } },
    ];
    if (options.kbIds && options.kbIds.length > 0) {
      must.push({ key: "kb_id", match: { any: options.kbIds } });
    }
    body.filter = { must };

    try {
      const res = await fetch(`${this.url}/collections/${options.collection || COLLECTION}/points/search`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.error("qdrant", "search failed", { status: res.status, body: text.slice(0, 200) });
        return [];
      }
      const data = (await res.json()) as { result: QdrantHit[] };
      return data.result.map((hit) => ({
        id: String(hit.id),
        text: (hit.payload.text as string) || "",
        similarity: hit.score,
        metadata: hit.payload,
      }));
    } catch (err) {
      logger.error("qdrant", "search fetch failed", { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }
  async upsert(chunks: ChunkUpsert[], options: { userId: string; kbId: string }): Promise<void> {
    if (chunks.length === 0) return;
    await this.ensureCollection();
    const points = chunks.map((c) => ({
      id: c.id,
      vector: c.embedding,
      payload: {
        user_id: options.userId,
        kb_id: options.kbId,
        document_id: c.documentId,
        document_title: c.documentTitle,
        text: c.text,
        ordinal: c.ordinal,
        source_type: c.sourceType,
        content_hash: hashContent(c.text),
        model: process.env.EMBED_MODEL || "unknown",
      },
    }));

    // Batch upsert (100 per request)
    const BATCH = 100;
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH);
      try {
        const res = await fetch(`${this.url}/collections/${COLLECTION}/points`, {
          method: "PUT",
          headers: this.headers(),
          body: JSON.stringify({ points: batch }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          logger.error("qdrant", "upsert failed", { status: res.status, batch: i / BATCH, body: text.slice(0, 200) });
        }
      } catch (err) {
        logger.error("qdrant", "upsert fetch failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async deleteByDocument(documentId: string): Promise<void> {
    try {
      const res = await fetch(`${this.url}/collections/${COLLECTION}/points/delete`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          filter: { must: [{ key: "document_id", match: { value: documentId } }] },
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.error("qdrant", "deleteByDocument failed", { status: res.status, body: text.slice(0, 200) });
      }
    } catch (err) {
      logger.error("qdrant", "deleteByDocument fetch failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async deleteByKb(kbId: string): Promise<void> {
    try {
      const res = await fetch(`${this.url}/collections/${COLLECTION}/points/delete`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          filter: { must: [{ key: "kb_id", match: { value: kbId } }] },
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.error("qdrant", "deleteByKb failed", { status: res.status, body: text.slice(0, 200) });
      }
    } catch (err) {
      logger.error("qdrant", "deleteByKb fetch failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["api-key"] = this.apiKey;
    return h;
  }
}
