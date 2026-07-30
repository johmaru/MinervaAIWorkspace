/**
 * Migration script: sqlite-vec → Qdrant
 *
 * Migrates kb_chunks from SQLite to a Qdrant collection.
 * Re-embeds all chunks with the current EMBEDDER_MODEL (required when
 * switching embedding models — vector spaces are incompatible).
 *
 * Usage:
 *   bun run scripts/migrate-to-qdrant.ts
 *
 * Prerequisites:
 *   1. Qdrant container running (docker compose --profile qdrant up -d qdrant)
 *   2. QDRANT_URL set in .env (or defaults to http://localhost:6333)
 *   3. EMBEDDER_MODEL set to the target model (e.g. cl-nagoya/ruri-v3-310m)
 *   4. embedder container running and reachable
 */

import { db } from "../src/db";
import { kbChunks, kbDocuments, knowledgeBases } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { embedTexts, hashContent } from "../src/lib/embed";
import { logger } from "../src/lib/logger";
import { randomUUID } from "node:crypto";

const QDRANT_URL = (process.env.QDRANT_URL || "http://localhost:6333").replace(/\/$/, "");
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || undefined;
const COLLECTION = "umanschat_kb";
const EMBED_DIM = Number(process.env.EMBED_DIM) || 768;
const EMBED_MODEL = process.env.EMBED_MODEL || "cl-nagoya/ruri-v3-310m";
const BATCH_SIZE = 100;
const EMBED_SLICE = 64;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_API_KEY) h["api-key"] = QDRANT_API_KEY;
  return h;
}

async function ensureCollection(): Promise<void> {
  // Check if collection exists
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    headers: headers(),
  });
  if (res.ok) {
    console.log(`Collection ${COLLECTION} already exists`);
    return;
  }
  if (res.status !== 404) {
    throw new Error(`Unexpected status checking collection: ${res.status}`);
  }

  // Create collection
  console.log(`Creating collection ${COLLECTION} (dim=${EMBED_DIM}, distance=Cosine)`);
  const createRes = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      vectors: { size: EMBED_DIM, distance: "Cosine" },
      optimizers_config: { indexing_threshold: 20000 },
    }),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Failed to create collection: ${createRes.status} ${text}`);
  }

  // Create payload index for user_id and kb_id (filter performance)
  for (const field of ["user_id", "kb_id"]) {
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}/index`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
    });
  }
  console.log(`Collection created with payload indexes on user_id, kb_id`);
}

async function fetchAllChunks(): Promise<{
  chunks: { id: string; text: string; ordinal: number; documentId: string; documentTitle: string; kbId: string; userId: string; sourceType: string }[];
  total: number;
}> {
  console.log("Fetching all kb_chunks from SQLite...");
  const rows = (await db.all(sql`
    SELECT kc.id, kc.text, kc.ordinal, kc.document_id,
           d.title AS document_title, d.source_type,
           kb.id AS kb_id, kb.user_id
    FROM kb_chunks kc
    INNER JOIN kb_documents d ON kc.document_id = d.id
    INNER JOIN knowledge_bases kb ON kc.knowledge_base_id = kb.id
    ORDER BY kc.document_id, kc.ordinal
  `)) as {
    id: string; text: string; ordinal: number; document_id: string;
    document_title: string; source_type: string; kb_id: string; user_id: string;
  }[];

  console.log(`Found ${rows.length} chunks`);
  return {
    chunks: rows.map((r) => ({
      id: r.id,
      text: r.text,
      ordinal: r.ordinal,
      documentId: r.document_id,
      documentTitle: r.document_title,
      kbId: r.kb_id,
      userId: r.user_id,
      sourceType: r.source_type || "file",
    })),
    total: rows.length,
  };
}

async function upsertBatch(points: {
  id: string; vector: number[];
  payload: Record<string, unknown>;
}[]): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ points }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Qdrant upsert failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function main() {
  console.log("=== sqlite-vec → Qdrant Migration ===");
  console.log(`Qdrant URL: ${QDRANT_URL}`);
  console.log(`Embedding model: ${EMBED_MODEL} (dim=${EMBED_DIM})`);
  console.log(`Collection: ${COLLECTION}`);
  console.log("");

  await ensureCollection();

  const { chunks, total } = await fetchAllChunks();
  if (total === 0) {
    console.log("No chunks to migrate. Exiting.");
    return;
  }

  console.log(`\nRe-embedding ${total} chunks with ${EMBED_MODEL}...`);
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < chunks.length; i += EMBED_SLICE) {
    const slice = chunks.slice(i, i + EMBED_SLICE);
    const texts = slice.map((c) => c.text);

    let vectors: number[][];
    try {
      vectors = await embedTexts(texts, "document");
    } catch (err) {
      console.error(`Embedding failed for batch ${i / EMBED_SLICE}:`, err);
      failed += slice.length;
      continue;
    }

    // Build upsert points
    const points = slice
      .map((c, j) => {
        const vec = vectors[j] ?? [];
        if (vec.length === 0) {
          console.warn(`Empty vector for chunk ${c.id}, skipping`);
          failed++;
          return null;
        }
        return {
          id: c.id,
          vector: vec,
          payload: {
            user_id: c.userId,
            kb_id: c.kbId,
            document_id: c.documentId,
            document_title: c.documentTitle,
            text: c.text,
            ordinal: c.ordinal,
            source_type: c.sourceType,
            content_hash: hashContent(c.text),
            model: EMBED_MODEL,
          },
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    // Upsert in batches
    for (let j = 0; j < points.length; j += BATCH_SIZE) {
      await upsertBatch(points.slice(j, j + BATCH_SIZE));
    }

    processed += slice.length;
    const pct = ((processed / total) * 100).toFixed(1);
    console.log(`Progress: ${processed}/${total} (${pct}%) — failed: ${failed}`);
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Total chunks: ${total}`);
  console.log(`Processed: ${processed}`);
  console.log(`Failed: ${failed}`);
  console.log(`\nNext steps:`);
  console.log(`1. Set VECTOR_BACKEND=qdrant in .env`);
  console.log(`2. Restart the app container`);
  console.log(`3. Verify search works`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
