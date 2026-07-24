import { createHash } from "crypto";
import { logger } from "@/lib/logger";

/**
 * Provider abstraction for embedding generation.
 *
 * Switches between two backends via `EMBED_PROVIDER` env:
 *   - `local` (default): runs an ONNX model locally via @xenova/transformers
 *   - `http`: delegates to a Python `sentence-transformers` service (embedder) via HTTP
 *
 * `kind` (`"query" | "document"`) controls the prompt prefix for asymmetric models
 * (e.g. LFM2.5). Only the `http` provider uses it; `local` (Xenova) ignores it.
 */

// Embedding model is configurable via env.
// Verified candidates (working with transformers.js):
//   Xenova/all-MiniLM-L6-v2               (384-dim, English-focused, fast)
//   Xenova/paraphrase-multilingual-MiniLM-L12-v2 (384-dim, multilingual, recommended: includes Japanese)
//   Xenova/multilingual-e5-small           (384-dim, multilingual)
//   Xenova/multilingual-e5-base            (768-dim, multilingual, higher accuracy)
// HTTP provider (Python embedder service):
//   LiquidAI/LFM2.5-Embedding-350M         (1024-dim, multilingual, sentence-transformers)
let MODEL_ID = process.env.EMBED_MODEL || "LiquidAI/LFM2.5-Embedding-350M";
let EMBED_DIM = Number(process.env.EMBED_DIM) || 1024;

/**
 * Startup check: verify EMBED_DIM matches stored vectors in the DB.
 * Logs a warning if mismatched — does not block startup so users can inspect data.
 */
async function checkEmbedDimConsistency(): Promise<void> {
  try {
    const { db } = await import("@/db");
    const { skills } = await import("@/db/schema");
    // Dynamic import to avoid circular dependency: embed.ts ← db/index.ts → embed.ts
    const [row] = await db.select({ embedding: skills.embedding }).from(skills).limit(1);
    if (row && Array.isArray(row.embedding) && row.embedding.length > 0) {
      if (row.embedding.length !== EMBED_DIM) {
        logger.error("embed", "EMBED_DIM mismatch detected", {
          envDim: EMBED_DIM,
          storedDim: row.embedding.length,
          hint: "Change EMBED_DIM back or re-embed all vectors",
        });
      }
    }
  } catch {
    // DB not ready yet (first run) — skip silently
  }
}

// Run check in background (non-blocking)
void checkEmbedDimConsistency();

type EmbedKind = "query" | "document";

type Pipeline = {
  (texts: string[], options?: { pooling: "mean"; normalize: boolean }): Promise<{
    data: Float32Array | number[][];
    tolist: () => number[][];
  }>;
};

let pipelinePromise: Promise<Pipeline> | null = null;

/**
 * Lazily initializes the transformers.js pipeline.
 * On first call, loads (downloads) the model.
 */
async function getPipeline(): Promise<Pipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const transformers = await import("@xenova/transformers");
      // sharp is for image processing. Not needed for text embedding.
      // Disabled to avoid errors from missing native binaries.
      try {
        transformers.env.backends.onnx.wasm.wasmPaths = "";
      } catch {
        // Continue even if env setting fails
      }
      // Avoid loading sharp: set flags via process.env
      // transformers.js v2 auto-detects sharp availability, but
      // explicitly disabled to avoid build failures with bundled sharp
      const { pipeline } = transformers;
      return pipeline("feature-extraction", MODEL_ID, {
        // No progress_callback (silent)
      }) as unknown as Pipeline;
    })();
  }
  return pipelinePromise;
}

/**
 * Whether the HTTP provider (Python embedder) is enabled.
 * True when `EMBED_PROVIDER=http` or `EMBEDDER_URL` is set.
 */
function isHttpProvider(): boolean {
  return process.env.EMBED_PROVIDER === "http";
}
/**
 * Delegates vector generation to the HTTP provider.
 * POSTs to the embedder's `/embed` and returns `vectors`.
 * On fetch failure / 503 (model loading), returns empty array (same as local).
 */
async function embedViaHttp(texts: string[], kind?: EmbedKind): Promise<number[][]> {
  const url = process.env.EMBEDDER_URL;
  if (!url) {
    logger.error("embed", "EMBED_PROVIDER=http but EMBEDDER_URL is not set");
    return texts.map(() => []);
  }
  try {
    const res = await fetch(`${url}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts, kind }),
    });
    if (!res.ok) {
      // 503 = model loading. Return empty arrays so the caller skips.
      logger.error("embed", "embedder HTTP error", { status: res.status });
      return texts.map(() => []);
    }
    const data = (await res.json()) as { vectors: number[][] };
    return data.vectors;
  } catch (err) {
    logger.error("embed", "embedder fetch failed", { error: err instanceof Error ? err.message : String(err) });
    return texts.map(() => []);
  }
}

/**
 * Call to discard the transformers.js pipeline cache on config changes
 * (when EMBED_MODEL / EMBED_DIM / EMBED_PROVIDER change).
 * Next embedText call reloads the pipeline with the new config.
 */
export function resetEmbedPipeline(): void {
  pipelinePromise = null;
  MODEL_ID = process.env.EMBED_MODEL || "LiquidAI/LFM2.5-Embedding-350M";
  EMBED_DIM = Number(process.env.EMBED_DIM) || 1024;
}
/**
 * Computes the contentHash (SHA-256) of a text.
 * Used to avoid re-embedding.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Generates an embedding vector from text.
 * Normalized. Dimensions follow EMBED_DIM.
 *
 * `kind` controls the prompt prefix for asymmetric models (LFM2.5 uses `query:` / `document:`).
 * Only used by the HTTP provider. Ignored by `local` (Xenova).
 *
 * Returns an empty array on error (caller skips).
 */
export async function embedText(text: string, kind?: EmbedKind): Promise<number[]> {
  if (!text.trim()) return [];
  if (isHttpProvider()) {
    const [vec] = await embedViaHttp([text], kind);
    return vec ?? [];
  }
  try {
    const extractor = await getPipeline();
    const output = await extractor([text], { pooling: "mean", normalize: true });
    const vectors = output.tolist();
    return vectors[0];
  } catch (err) {
    logger.error("embed", "embedding failed", { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Batch-embeds multiple texts.
 * transformers.js supports batch input, but processes in chunks of
 * up to 16 at a time for memory efficiency.
 * The HTTP provider delegates batching to the embedder side.
 */
export async function embedTexts(texts: string[], kind?: EmbedKind): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (isHttpProvider()) {
    return embedViaHttp(texts, kind);
  }
  const results: number[][] = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    try {
      const extractor = await getPipeline();
      const output = await extractor(batch, { pooling: "mean", normalize: true });
      const vectors = output.tolist();
      results.push(...vectors);
    } catch (err) {
      logger.error("embed", "batch embedding failed", { error: err instanceof Error ? err.message : String(err) });
      // Fill with empty vectors on error
      for (let j = 0; j < batch.length; j++) {
        results.push([]);
      }
    }
  }
  return results;
}

export { EMBED_DIM };
