# Embeddings & Vector Search

Documentation of UmansChat's embedding generation subsystem: the provider abstraction over local ONNX and HTTP Python embedders, embedding storage in SQLite, client-side cosine similarity search, content hashing for deduplication, and the dimension-migration flow.

## Relevant source files

- `src/lib/embed.ts` — provider abstraction, pipeline lifecycle, `embedText` / `embedTexts` / `hashContent` / `resetEmbedPipeline`
- `src/lib/vectorSearch.ts` — `cosineSimilarity()` pure-JS helper
- `src/app/api/settings/route.ts` — `EMBED_MODEL_BASE` candidate list, dimension migration flow (`POST /api/settings`)
- `src/db/schema.ts` — `memories`, `skills`, and `page_embeddings` table definitions (JSON embedding columns)
- `src/lib/memory.ts` — memory extraction & storage (calls `embedText`)
- `src/lib/memoryStore.ts` — RAG retrieval (calls `cosineSimilarity`)
- `src/lib/skillStore.ts` — skill retrieval (calls `cosineSimilarity`)
- `src/lib/pageStore.ts` — page upsert + `page_embeddings` generation

## Overview

UmansChat abstracts embedding generation behind a single `embedText` / `embedTexts` interface in `src/lib/embed.ts`. Two backends are selectable at runtime via environment variables:

- **Local provider** (default `local`) — runs an ONNX model in-process via `@xenova/transformers` (transformers.js). No external service required; the model weights are downloaded lazily on first use.
- **HTTP provider** (`http`) — delegates to a Python `sentence-transformers` microservice (the "embedder") reachable at `EMBEDDER_URL`. The app POSTs batches of texts and receives vector arrays back.

Both providers return normalized floating-point vectors whose dimensionality is governed by `EMBED_DIM`. Callers (`memory.ts`, `skillStore.ts`, `pageStore.ts`) are provider-agnostic: they call `embedText(text, kind)` and receive `number[]` (or `number[][]` for batches). On any failure the providers return an empty array, and callers skip persistence/search for that item rather than throwing.

## Configuration

Embedding behavior is controlled by four environment variables, read at call time (not boot time) so settings changes take effect after `resetEmbedPipeline()`:

| Env var | Default | Description |
|---------|---------|-------------|
| `EMBED_MODEL` | `LiquidAI/LFM2.5-Embedding-350M` | Hugging Face model identifier. For the local provider this must be a transformers.js-compatible ONNX repo (typically under the `Xenova/` namespace). For the HTTP provider it is the model name the Python embedder loads. |
| `EMBED_DIM` | `1024` | Vector dimensionality. Used by the app for validation and migration checks. Because embeddings are stored as JSON text arrays in SQLite (not a fixed-width vector column), the dimension is **not** enforced by the database — it is a runtime contract. |
| `EMBED_PROVIDER` | (unset → `local`) | `"local"` for transformers.js, or `"http"` for the Python embedder service. |
| `EMBEDDER_URL` | (unset) | Base URL of the Python embedder service (e.g. `http://localhost:8001`). Required when `EMBED_PROVIDER=http`; if missing, the HTTP provider logs an error and returns empty arrays. |

These are persisted in `.env` and surfaced in the Settings UI (`GET /api/settings` → `embedModel`, `embedDim`, `embedProvider`, `embedModelOptions`). Changing them via `POST /api/settings` writes the `.env`, updates `process.env`, and invokes `resetEmbedPipeline()` to discard any cached transformers.js pipeline (see [Dimension migration](#dimension-migration) below).

## Model candidates

The Settings API exposes a curated list of supported models in `EMBED_MODEL_BASE` (`src/app/api/settings/route.ts:28-59`). Each candidate declares its dimension and provider, and carries a `labelKey` for localized UI labels.

| Model | Dimensions | Provider | Notes |
|-------|-----------:|----------|-------|
| `Xenova/all-MiniLM-L6-v2` | 384 | `local` | English-focused, fast |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 384 | `local` | Multilingual, recommended (includes Japanese) |
| `Xenova/multilingual-e5-small` | 384 | `local` | Multilingual |
| `Xenova/multilingual-e5-base` | 768 | `local` | Multilingual, higher accuracy |
| `LiquidAI/LFM2.5-Embedding-350M` | 1024 | `http` | Multilingual, sentence-transformers (default) |

The local candidates are symmetric embedding models run via transformers.js; the HTTP candidate (LFM2.5) is an asymmetric model served by the Python embedder and uses the `kind` parameter (see below). A model not in this list can still be used by setting `EMBED_MODEL`/`EMBED_PROVIDER`/`EMBED_DIM` directly in `.env`, provided the local provider has a transformers.js build of it or the HTTP embedder is configured to load it.

## Local provider — transformers.js

When `EMBED_PROVIDER` is not `"http"`, embeddings are generated in-process via `@xenova/transformers`.

### Lazy pipeline initialization

The transformers.js pipeline is created on first use and cached in a module-level `pipelinePromise`. Subsequent `embedText`/`embedTexts` calls reuse the cached pipeline — the model is downloaded and loaded only once per process (or until `resetEmbedPipeline()` clears the cache):

```typescript
async function getPipeline(): Promise<Pipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const transformers = await import("@xenova/transformers");
      // ... wasm path + sharp-disabled setup ...
      const { pipeline } = transformers;
      return pipeline("feature-extraction", MODEL_ID, {}) as unknown as Pipeline;
    })();
  }
  return pipelinePromise;
}
```

The dynamic `import("@xenova/transformers")` keeps the (large) library out of the initial bundle. On first call after a model change, the new model is fetched from the Hugging Face Hub.

### Pooling and normalization

The local provider uses transformers.js' `feature-extraction` pipeline with mean pooling and L2 normalization:

```typescript
const output = await extractor([text], { pooling: "mean", normalize: true });
const vectors = output.tolist();
return vectors[0];
```

This produces unit-length vectors, which is the form `cosineSimilarity()` expects (though the function is robust to non-normalized inputs — it divides by magnitudes explicitly).

### Batch handling

`embedTexts()` processes texts in chunks of 16 to bound memory usage:

```typescript
const BATCH = 16;
for (let i = 0; i < texts.length; i += BATCH) {
  const batch = texts.slice(i, i + BATCH);
  // ... extractor(batch, { pooling: "mean", normalize: true }) ...
}
```

On a batch error, the failed batch's slots are filled with empty arrays (callers skip them) rather than aborting the whole call.

### `kind` is ignored

The local Xenova models are symmetric, so the `kind` parameter (`"query"` / `"document"`) is accepted but not used — no prompt prefix is applied. See [The `kind` parameter](#the-kind-parameter).

## HTTP provider — Python embedder

When `EMBED_PROVIDER === "http"`, embedding generation is delegated to a Python `sentence-transformers` microservice reachable at `EMBEDDER_URL`.

### Request contract

`POST {EMBEDDER_URL}/embed` with JSON body `{ texts: string[], kind?: "query" | "document" }`. The expected response is `{ vectors: number[][] }`:

```typescript
const res = await fetch(`${url}/embed`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ texts, kind }),
});
// ...
const data = (await res.json()) as { vectors: number[][] };
return data.vectors;
```

The Python embedder is responsible for model loading, batching, and applying the `kind` prefix for asymmetric models (e.g., LFM2.5 prepends `query:` / `document:`).

### 503 while loading

Embedding models are large; on first request after the embedder boots, the model may still be loading. The embedder signals this with HTTP `503`, and `embedViaHttp` treats any non-OK response (including 503) the same as a fetch failure: it logs and returns one empty array per input text:

```typescript
if (!res.ok) {
  // 503 = model loading. Return empty arrays so the caller skips.
  console.error(`[embed] embedder HTTP ${res.status}`);
  return texts.map(() => []);
}
```

This makes cold-start transient: callers (`memory.ts`, `pageStore.ts`) skip persisting an embedding for that turn, and the next successful request embeds normally. `embedText` similarly returns `[]` on fetch exceptions and on empty/whitespace input (`if (!text.trim()) return [];`).

### Missing `EMBEDDER_URL`

If `EMBED_PROVIDER=http` but `EMBEDDER_URL` is unset, the provider logs `[embed] EMBED_PROVIDER=http but EMBEDDER_URL is not set` and returns empty arrays — no exception is thrown to the caller.

## The `kind` parameter

```typescript
type EmbedKind = "query" | "document";
```

`kind` distinguishes the two sides of an **asymmetric** embedding model. LFM2.5 (the default HTTP model) is asymmetric: it expects a `query:` prefix for search queries and a `document:` prefix for stored text. The Python embedder applies these prefixes internally based on the `kind` value it receives.

| Caller | `kind` | Reason |
|--------|--------|--------|
| Memory/skill/page **storage** (`memory.ts`, `skillStore.ts` approval, `pageStore.ts`) | `"document"` | Text being indexed for later retrieval |
| Memory/skill **retrieval** (`memoryStore.ts`, `skillStore.ts` search) | `"query"` | The user's incoming search query |

The **local** Xenova provider ignores `kind` entirely (symmetric models need no prefix). Passing `kind` to `embedText` is therefore always safe regardless of provider — it simply has no effect under `local`.

## Embedding storage

Embeddings are stored as **JSON text arrays** in SQLite, not as native vector columns. All three embedding-bearing tables define the column identically:

```typescript
embedding: text("embedding", { mode: "json" }).$type<number[]>().notNull(),
```

| Table | Column | File |
|-------|--------|------|
| `memories` | `embedding` | `src/db/schema.ts:336` |
| `skills` | `embedding` | `src/db/schema.ts:112` |
| `page_embeddings` | `embedding` | `src/db/schema.ts:416` |

### Drizzle auto-parse

Drizzle's `{ mode: "json" }` instructs the driver to serialize `number[]` to a JSON string on write and parse it back to `number[]` on read automatically. Application code therefore works with plain `number[]` everywhere — no manual `JSON.parse`/`JSON.stringify` is needed at call sites.

### Dimension is not column-enforced

Because the column is a `text` column holding a JSON array, SQLite does not enforce the vector dimension. A 384-dim vector and a 1024-dim vector both fit. The dimension is instead a **runtime contract** governed by `EMBED_DIM`:

- `cosineSimilarity()` guards against dimension mismatch by returning `0` when `a.length !== b.length` (see [Vector search](#vector-search)).
- The migration flow (below) exists precisely because mixing vectors from different model spaces yields meaningless similarity scores, even when dimensions happen to match.

The `model` column on `memories` and `page_embeddings` records which embedding model produced each vector (`"manual"` for API-created memories), aiding diagnosis but not enforcing compatibility.

## Vector search

UmansChat performs vector search entirely in JavaScript — there is no pgvector or SQLite vector extension. All candidate rows for a user are loaded into memory and scored in a loop. The core computation lives in `src/lib/vectorSearch.ts`:

```typescript
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}
```

### Cosine similarity

Cosine similarity measures the angle between two vectors, ranging from `-1` (opposite) through `0` (orthogonal) to `1` (identical direction). The formula is $\cos\theta = \frac{\mathbf{a}\cdot\mathbf{b}}{|\mathbf{a}|\,|\mathbf{b}|}$, computed in a single pass over the vectors. Because the embedding providers return L2-normalized vectors, $|\mathbf{a}|=|\mathbf{b}|=1$ in the common case and the result reduces to the dot product — but the function computes magnitudes explicitly so it is correct for un-normalized input too.

### Edge cases

The function defensively returns `0` (semantically "no similarity") in three situations:

| Condition | Return | Rationale |
|-----------|-------:|-----------|
| Either array is empty (`length === 0`) | `0` | Embedding generation failed (model loading / error); nothing to compare |
| Dimensions mismatch (`a.length !== b.length`) | `0` | Vectors from different model spaces; comparing them is meaningless |
| Either vector is zero magnitude (`denom === 0`) | `0` | Avoids division by zero; a zero vector has no direction |

Returning `0` rather than throwing lets retrieval pipelines (`memoryStore.ts`, `skillStore.ts`) treat failed/empty embeddings as simply non-matching, filtering them out via the `similarity > 0.3` threshold.

### How retrieval uses it

Both memory and skill retrieval follow the same pattern: embed the query with `kind: "query"`, fetch candidate rows, score each with `cosineSimilarity(queryVector, row.embedding)`, filter by a `0.3` threshold, then rank (memories additionally blend in a recency score). See [Memory](./memory.md) and [Skills](./skills.md) for the full retrieval algorithms.

## Content hashing

`hashContent()` computes a SHA-256 digest of a text string, used to detect duplicate content and skip redundant re-embedding:

```typescript
import { createHash } from "crypto";

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
```

The hash is stored in the `contentHash` column of `memories`, `skills`, and `page_embeddings`. Dedup checks compare the stored hash against the incoming content's hash before embedding:

- **Memories** (`memory.ts`): before inserting a `"new"` memory, the content's hash is checked against existing memories in the same thread — duplicates are skipped.
- **Skills** (`skillStore.ts`): on candidate approval, a duplicate `contentHash` promotes the candidate to `merged` status instead of inserting a duplicate skill.
- **Pages** (`pageStore.ts`): `upsertPage()` compares the incoming `contentHash` against the existing page's hash; a match is a cache hit that skips both re-fetching and re-embedding the page body.

Because the hash is computed from the raw content string (before embedding), it is provider- and dimension-independent — content dedup works identically whether embeddings are 384- or 1024-dimensional.

## Dimension migration

When `EMBED_DIM` changes — whether by switching `EMBED_MODEL` to a different-dimensional model or by editing `EMBED_DIM` directly — existing stored vectors become **incompatible** with the new model's vector space (different models project text into different, non-comparable spaces, even at equal dimensionality). The `POST /api/settings` endpoint handles this migration explicitly.

### Why migration is needed

The embedding column is `text` (JSON), so **no DDL** is required to change dimensions — a JSON array of any length fits the column. The problem is semantic: cosine similarity between vectors from two different model spaces is meaningless. All existing embedding data must therefore be invalidated.

### The migration flow

When the Settings UI submits an `embedDim` that differs from the current `dbVectorDim`, the server responds `409` with `error: "migration_required"` and a confirmation prompt. The user must acknowledge the data deletion and resubmit with `applyMigration: true`. The flow then runs in `src/app/api/settings/route.ts`:

1. **Update `process.env` first.** `EMBED_MODEL`, `EMBED_DIM`, and `EMBED_PROVIDER` are written to `process.env` before any embedding call, so `embedText` uses the new config. (The `.env` file itself is written later.)
2. **`resetEmbedPipeline()`** discards the cached transformers.js pipeline so the next call loads the new model.
3. **Clear `memories` and `page_embeddings`.** These are regenerable — memories are re-extracted from future conversations, and page embeddings are regenerated when pages are next scraped — so they are deleted.
4. **Re-embed `skills`** (not deleted). Skills are user-authored persistent prompts that cannot be automatically regenerated, so each skill's `content` is re-embedded with the new model and its `embedding` row updated in place:

```typescript
const allSkills = await db.select({ id: skills.id, content: skills.content }).from(skills);
for (const skill of allSkills) {
  const vector = await embedText(skill.content, "document");
  await db.update(skills).set({ embedding: vector }).where(eq(skills.id, skill.id));
}
```

5. **Persist to `.env`** and update `process.env` for all settings. `resetEmbedPipeline()` is also called on any embedding-related env change even without a dimension change (e.g., switching `EMBED_PROVIDER`).

### After migration

The response includes `migrationApplied: true` and a message instructing the user to restart the app. Until restart, the in-process pipeline reflects the new config; the `.env` persists it for subsequent boots. Memories and page embeddings are repopulated organically as new conversations occur and pages are re-scraped.

### Non-migration config changes

If `embedDim` is unchanged but `EMBED_MODEL` or `EMBED_PROVIDER` changes, no data deletion occurs — only `resetEmbedPipeline()` runs to reload the pipeline. Note that switching to a model with the same declared `EMBED_DIM` but a different actual vector space will still produce semantically incompatible embeddings; the migration guard only triggers on a dimension delta, so operators should manually clear embeddings when switching models at equal dimension.

## See also

- [Memory](./memory.md) — memory extraction, RAG retrieval, and how embeddings feed context injection
- [Skills](./skills.md) — skill retrieval and the approval pipeline that generates skill embeddings
- [Database](./database.md) — schema for the `memories`, `skills`, `page_embeddings`, and `pages` tables
- [Settings & Environment](./settings-env.md) — all environment variables including `EMBED_*` and the Settings API
