/**
 * Vector search helper — sqlite-vec backed cosine similarity.
 *
 * Embeddings are stored as Float32 BLOB (embeddingColumn customType in schema.ts).
 * sqlite-vec provides vec_distance_cosine() which computes 1 - cosine_similarity.
 *
 * This module exports:
 * - cosineSimilarity(): legacy JS fallback for in-memory vectors (tests, small sets)
 * - toVecBuffer(): convert number[] to Float32Array Buffer for SQL parameter binding
 * - similarityToDistance() / distanceToSimilarity(): threshold conversion helpers
 */

import { db } from "@/db";

/**
 * Converts a number[] embedding to a Float32Array Buffer for SQL parameter binding.
 * Used as the query vector in vec_distance_cosine(?, embedding) calls.
 */
export function toVecBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/**
 * Cosine similarity → cosine distance (sqlite-vec convention).
 * vec_distance_cosine returns distance = 1 - similarity.
 * similarity > 0.3 → distance < 0.7
 */
export function similarityToDistance(similarity: number): number {
  return 1 - similarity;
}

/**
 * Cosine distance → cosine similarity.
 */
export function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}

/**
 * Cosine similarity in JS (fallback / test utility).
 * Returns 0 for zero vectors or dimension mismatch.
 *
 * Kept for:
 * - Tests that need pure-JS cosine without DB round-trips
 * - Any future in-memory vector comparison (e.g. small candidate sets where SQL overhead isn't worth it)
 */
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

/**
 * Raw SQLite access — used by vecSearch helpers to run vec_distance_cosine queries
 * via the better-sqlite3 instance that has sqlite-vec loaded.
 *
 * Drizzle's db.run() / db.all() don't expose the raw prepare() needed for
 * parameterized vec_distance_cosine queries with Buffer bindings, so we access
 * the underlying better-sqlite3 Database instance.
 */
export { db };
