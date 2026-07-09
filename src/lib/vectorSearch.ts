/**
 * Client-side vector search helper — computes cosine similarity in JS instead of using pgvector.
 *
 * In SQLite, embeddings are stored as JSON arrays (text column, mode: json),
 * and Drizzle auto-parses them into number[]. No parse handling is needed.
 * This module only provides cosine similarity computation.
 */

/**
 * Cosine similarity: a·b / (|a||b|).
 * Returns 0 for zero vectors (avoids division by zero).
 * Returns 0 if dimensions do not match.
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
