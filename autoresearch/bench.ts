/**
 * Deterministic benchmark harness for search-query diversification.
 *
 * Runs a fixed fixture set through `decideSearch` with a mocked OpenAI client
 * (no network, no model non-determinism) and prints structural metrics over the
 * emitted `queries[]` as `METRIC <name>=<value>` lines.
 *
 * Invoked by ../autoresearch.sh via tsx so the project's tsconfig `@/` path
 * aliases resolve. LLM_BASE_URL MUST be unset/empty so buildDisableReasoningParams
 * falls back to the static MODEL_REASONING map (no fetch).
 *
 * 2-phase decideSearch: the mock client returns different content on sequential
 * calls — 1st call = judge response (searchLevel only), 2nd call = queryGen
 * response (queries only). For heuristic-shortcircuiting fixtures (none/wiki),
 * only the judge response is used (queryGen is skipped).
 *
 * For heuristic-web fixtures we inject a canned "none" judge response so
 * decideSearch returns heuristicDecision (the heuristic web queries) via the
 * `searchLevel === "none" && heuristicDecision` fallback.
 * This lets the bench measure the heuristic web query array, not a canned one.
 */
import { decideSearch, type SearchDecision, type SearchQuery } from "@/lib/searchDecision";

type Fixture = {
  id: string;
  input: string;
  locale: "ja" | "en";
  /**
   * Canned LLM JSON responses for the 2-phase decideSearch.
   * [0] = judge response, [1] = queryGen response (only used if judge != none).
   */
  canned: string[];
};

/**
 * Fake OpenAI client: chat.completions.create resolves to sequential contents.
 * 1st call returns contents[0] (judge), 2nd returns contents[1] (queryGen).
 * Deterministic — no network, no Date.now(), no Math.random().
 */
function mockClient(contents: string[]) {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const content = callIndex < contents.length ? contents[callIndex] : contents[contents.length - 1];
          callIndex++;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

// Canned LLM judge responses (Phase A: searchLevel only, no queries).
const CANNED_JUDGE_NONE = JSON.stringify({
  searchLevel: "none",
  reason: "router would defer",
  userNotice: null,
});

const CANNED_JUDGE_WEB = JSON.stringify({
  searchLevel: "web",
  reason: "latest evaluation needed",
  userNotice: "最新の評価やレビューをWebで確認します。",
});

const CANNED_JUDGE_WIKI = JSON.stringify({
  searchLevel: "wiki",
  reason: "named entity lookup",
  userNotice: "Wikipediaで調べます。",
});

// Canned LLM queryGen responses (Phase B: queries only).
const CANNED_QUERY_WEB_4 = JSON.stringify({
  queries: [
    { query: "GLM5.2 評価 最新 レビュー", time_range: null },
    { query: "GLM5.2 review rating benchmark", time_range: null },
    { query: "GLM-5.2 性能 比較", time_range: null },
    { query: "GLM5.2 evaluation latest", time_range: null },
  ],
});

const CANNED_QUERY_WIKI_2 = JSON.stringify({
  queries: [
    { query: "アインシュタイン", time_range: null },
    { query: "Albert Einstein", time_range: null },
  ],
});

const FIXTURES: Fixture[] = [
  { id: "none-code", input: "Pythonのリスト内包表記を教えて", locale: "ja", canned: [CANNED_JUDGE_NONE] },
  { id: "web-heuristic", input: "PMR2.0のSteam評価は？最新のレビュー", locale: "ja", canned: [CANNED_JUDGE_NONE] },
  { id: "wiki-cjk", input: "Bunって何？", locale: "ja", canned: [CANNED_JUDGE_NONE] },
  { id: "wiki-ascii", input: "tRPCとは", locale: "ja", canned: [CANNED_JUDGE_NONE] },
  { id: "web-llm", input: "最新のGLM5.2の評価どう？", locale: "ja", canned: [CANNED_JUDGE_WEB, CANNED_QUERY_WEB_4] },
  { id: "wiki-llm", input: "アインシュタインについて教えて", locale: "ja", canned: [CANNED_JUDGE_WIKI, CANNED_QUERY_WIKI_2] },
];

function tokenize(s: string): Set<string> {
  // Split on whitespace and CJK/punctuation, lowercase. Good enough for Jaccard.
  return new Set(
    s
      .toLowerCase()
      .split(/[\s\p{P}\p{S}]+/u)
      .filter((t) => t.length > 0),
  );
}

function jaccardDistance(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

const CJK_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;
const ASCII_RE = /[A-Za-z]/;

async function main() {
  const decisions: { id: string; decision: SearchDecision }[] = [];
  for (const fx of FIXTURES) {
    const client = mockClient(fx.canned);
    const decision = await decideSearch(fx.input, "umans-glm-5.2", fx.locale, [], client as never, "Current date: 2026-07-11");
    decisions.push({ id: fx.id, decision });
  }

  // Only search decisions (web + wiki) contribute to query metrics.
  const searchDecisions = decisions.filter((d) => d.decision.searchLevel !== "none");
  const allQueries: SearchQuery[] = searchDecisions.flatMap((d) => d.decision.queries);
  // For tokenization-based metrics, extract query strings from SearchQuery[]
  const allQueryStrings = allQueries.map((sq) => sq.query);

  const totalQueries = allQueryStrings.length;
  const avgPerSearch = searchDecisions.length === 0 ? 0 : totalQueries / searchDecisions.length;
  const webQueries = searchDecisions
    .filter((d) => d.decision.searchLevel === "web")
    .flatMap((d) => d.decision.queries.map((sq) => sq.query)).length;
  const wikiQueries = searchDecisions
    .filter((d) => d.decision.searchLevel === "wiki")
    .flatMap((d) => d.decision.queries.map((sq) => sq.query)).length;

  // dual_lang_coverage: fraction of search decisions with >=1 non-CJK (English)
  // query AND >=1 CJK/locale-matching query.
  let dualLang = 0;
  for (const d of searchDecisions) {
    const qs = d.decision.queries.map((sq) => sq.query);
    const hasNonCjk = qs.some((q) => !CJK_RE.test(q) && ASCII_RE.test(q));
    const hasCjk = qs.some((q) => CJK_RE.test(q));
    if (hasNonCjk && hasCjk) dualLang++;
  }
  const dualLangCoverage = searchDecisions.length === 0 ? 0 : dualLang / searchDecisions.length;

  // query_diversity: mean pairwise Jaccard distance within each decision, averaged.
  let diversitySum = 0;
  for (const d of searchDecisions) {
    const qs = d.decision.queries.map((sq) => sq.query);
    if (qs.length < 2) continue;
    const tokenSets = qs.map(tokenize);
    let pairSum = 0;
    let pairCount = 0;
    for (let i = 0; i < tokenSets.length; i++) {
      for (let j = i + 1; j < tokenSets.length; j++) {
        pairSum += jaccardDistance(tokenSets[i], tokenSets[j]);
        pairCount++;
      }
    }
    if (pairCount > 0) diversitySum += pairSum / pairCount;
  }
  const queryDiversity = searchDecisions.length === 0 ? 0 : diversitySum / searchDecisions.length;

  // Per-fixture detail for debugging (stderr, not parsed as metrics).
  for (const d of decisions) {
    process.stderr.write(
      `[bench] ${d.id}: level=${d.decision.searchLevel} queries=[${d.decision.queries.map((sq) => `"${sq.query}"`).join(", ")}]\n`,
    );
  }

  // Primary metric line first, then secondaries.
  process.stdout.write(`METRIC query_diversity=${queryDiversity.toFixed(6)}\n`);
  process.stdout.write(`METRIC dual_lang_coverage=${dualLangCoverage.toFixed(6)}\n`);
  process.stdout.write(`METRIC avg_queries_per_search=${avgPerSearch.toFixed(6)}\n`);
  process.stdout.write(`METRIC total_queries=${totalQueries}\n`);
  process.stdout.write(`METRIC web_query_count=${webQueries}\n`);
  process.stdout.write(`METRIC wiki_query_count=${wikiQueries}\n`);
}

main().catch((err) => {
  process.stderr.write(`bench failed: ${String(err)}\n`);
  process.exit(1);
});
