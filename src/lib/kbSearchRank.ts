/**
 * Hybrid re-ranking helpers for knowledge-base RAG.
 *
 * Pure vector search over character dialogue often ranks the wrong speaker:
 * a query like「愛が過去にはまってる…」embeds as "someone was into X", so
 * 白石沙季's「ハマッています」beats 小美山愛's hobby lines that never say はま.
 *
 * These helpers extract subject/name hints and keyword tokens from the query
 * and boost hits whose document title (speaker) or text matches them.
 */

export type RankableKbHit = {
  chunkId: string;
  documentId: string;
  kbId: string;
  text: string;
  similarity: number;
  title: string;
};

/** Speaker name from title convention: "小美山愛 | メッセージ | …" → 小美山愛 */
export function titleSpeaker(title: string): string {
  const head = title.split("|")[0]?.trim() ?? title.trim();
  return head;
}

const SUBJECT_STOP = new Set([
  "私",
  "僕",
  "俺",
  "自分",
  "それ",
  "これ",
  "あれ",
  "何",
  "誰",
  "どれ",
  "過去",
  "最近",
  "昔",
  "今",
  "物",
  "もの",
  "事",
  "こと",
  "話",
  "試し",
  "質問",
  "ユーザー",
  "自分",
  "彼女",
  "彼",
  "人",
  "キャラ",
  "キャラクター",
]);

/**
 * Extract likely subject / name tokens from a Japanese question.
 * e.g. 「愛が過去にはまってる」→ ["愛"] (not the whole clause before が).
 */
export function extractSubjectHints(query: string): string[] {
  const hints = new Set<string>();
  // Prefer a short name immediately before topic/subject particles.
  // Do NOT allow greedy [ぁ-ん]+ runs — that swallowed「試しに愛が…」as one token.
  const particleRe =
    /([一-龯]{1,6}|[ァ-ヶー]{2,12}|[a-zA-Z][a-zA-Z0-9_-]{1,20})(?:が|は|も|って|ちゃん|さん|様|さま)/g;
  let m: RegExpExecArray | null;
  while ((m = particleRe.exec(query)) !== null) {
    const t = m[1]!;
    if (!SUBJECT_STOP.has(t)) hints.add(t);
  }
  // Explicit multi-kanji name runs present in the query (e.g. 小美山愛)
  for (const run of query.match(/[一-龯]{2,6}/g) ?? []) {
    if (!SUBJECT_STOP.has(run)) hints.add(run);
  }
  return [...hints];
}

/** Expand はま/ハマ orthography variants for keyword matching. */
export function expandTokenVariants(token: string): string[] {
  const out = new Set<string>([token]);
  if (token.includes("はま")) out.add(token.replace(/はま/g, "ハマ"));
  if (token.includes("ハマ")) out.add(token.replace(/ハマ/g, "はま"));
  if (token.includes("ハマッ")) out.add(token.replace(/ハマッ/g, "はまっ"));
  if (token.includes("はまっ")) out.add(token.replace(/はまっ/g, "ハマッ"));
  return [...out];
}

/**
 * Keyword tokens for hybrid LIKE search (subjects + hobby verbs + longer CJK runs).
 */
export function extractKeywordTokens(query: string): string[] {
  const tokens = new Set<string>(extractSubjectHints(query));
  const hobby = ["はまって", "ハマッて", "ハマって", "はまっ", "趣味", "好き", "熱中", "夢中"];
  for (const h of hobby) {
    if (query.includes(h) || query.replace(/ッ/g, "").includes(h.replace(/ッ/g, ""))) {
      tokens.add(h.length >= 2 ? h : h);
    }
  }
  // Continuous CJK/kana runs of length 2–8
  const runs = query.match(/[一-龯ぁ-んァ-ヶー]{2,8}/g) ?? [];
  for (const r of runs) {
    if (!SUBJECT_STOP.has(r)) tokens.add(r);
  }
  // Drop pure question fluff
  for (const fluff of ["って言", "言って", "ものは", "何？", "何?", "試しに"]) {
    tokens.delete(fluff);
  }
  return [...tokens]
    .filter((t) => t.length >= 1 && t.length <= 16)
    .slice(0, 10);
}

/**
 * Score a hit for final ranking. Higher is better.
 * Base = vector similarity (0–1); keyword-only hits should pass ~0.45–0.55.
 */
export function scoreKbHit(hit: RankableKbHit, query: string, subjects: string[]): number {
  let score = hit.similarity;
  const speaker = titleSpeaker(hit.title);
  const q = query;
  const text = hit.text;

  if (speaker && q.includes(speaker)) {
    score += 0.45;
  }
  for (const s of subjects) {
    if (!s) continue;
    if (speaker.includes(s)) {
      // Speaker identity beats raw vector when the question names the character.
      // Single-char Japanese given names (愛) still need a large boost vs ハマ-keyword hits.
      score += s.length >= 3 ? 0.42 : s.length === 2 ? 0.36 : 0.38;
    } else if (hit.title.includes(s)) {
      score += 0.12;
    }
  }

  // Hobby orthography overlap
  const qHama = /はま|ハマ/.test(q);
  const tHama = /はま|ハマ/.test(text);
  if (qHama && tHama) score += 0.08;

  // Prefer chunks that literally name the speaker in body (dialogue docs)
  if (speaker && text.includes(speaker)) score += 0.05;

  return score;
}

/**
 * Merge vector + keyword hits by chunkId, keep best similarity, re-rank, slice.
 */
export function mergeAndRerankKbHits(
  vectorHits: RankableKbHit[],
  keywordHits: RankableKbHit[],
  query: string,
  limit: number,
): RankableKbHit[] {
  const subjects = extractSubjectHints(query);
  const byId = new Map<string, RankableKbHit>();

  for (const h of [...vectorHits, ...keywordHits]) {
    const prev = byId.get(h.chunkId);
    if (!prev || h.similarity > prev.similarity) {
      byId.set(h.chunkId, h);
    }
  }

  const ranked = [...byId.values()]
    .map((h) => ({
      hit: h,
      rank: scoreKbHit(h, query, subjects),
    }))
    .sort((a, b) => b.rank - a.rank || b.hit.similarity - a.hit.similarity)
    .slice(0, limit)
    .map(({ hit, rank }) => ({
      ...hit,
      // Expose re-ranked score as similarity so UI/agent see the adjusted order
      similarity: Number(Math.min(0.999, rank).toFixed(3)),
    }));

  return ranked;
}

/**
 * Prefix chunk text with document title when the speaker name is missing.
 * Keeps multi-chunk docs attributable after 512-char splits.
 */
export function prefixChunkWithTitle(title: string, chunkTextValue: string): string {
  const speaker = titleSpeaker(title);
  if (!speaker) return chunkTextValue;
  if (chunkTextValue.includes(speaker)) return chunkTextValue;
  return `【${title}】\n${chunkTextValue}`;
}
