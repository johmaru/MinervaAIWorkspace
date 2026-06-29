/**
 * アプリ側ベクトル検索ヘルパ — pgvector の代わりに JS でコサイン類似度を計算。
 *
 * SQLite では embedding は JSON 配列（text 列, mode: json）として保存され、
 * Drizzle が number[] に自動パースする。そのため parse 処理は不要。
 * このモジュールはコサイン類似度計算のみを提供する。
 */

/**
 * コサイン類似度: a·b / (|a||b|)。
 * ゼロベクトルの場合は 0 を返す（除算回避）。
 * 次元が一致しない場合は 0 を返す。
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
