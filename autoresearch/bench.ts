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
 * Why every fixture gets a mock client: decideSearch calls
 * `const llm = client ?? createLLM()` OUTSIDE its try/catch (line 225). For
 * heuristic-web inputs (which do NOT short-circuit), a missing client makes
 * createLLM() throw synchronously and crash the bench when LLM_BASE_URL is
 * unset. Heuristic-none/wiki fixtures short-circuit before that line, but we
 * pass a client anyway for robustness against future heuristic changes.
 *
 * For heuristic-web fixtures we inject a canned "none" router response so
 * decideSearch returns heuristicDecision (the heuristic web queries) via the
 * `parsed.searchLevel === "none" && heuristicDecision` fallback (line 241).
 * This lets the bench measure the heuristic web query array, not a canned one.
 */
import { decideSearch, type SearchDecision } from "@/lib/searchDecision";

type Fixture = {
  id: string;
  input: string;
  locale: "ja" | "en";
  /** Canned LLM JSON response. Every fixture gets one (see header). */
  canned: string;
};

/**
 * Fake OpenAI client: chat.completions.create resolves to a fixed content.
 * Deterministic — no network, no Date.now(), no Math.random().
 */
function mockClient(content: string) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content } }],
        }),
      },
    },
  };
}

// Canned LLM router responses (valid SearchDecision JSON).
const CANNED_NONE = JSON.stringify({
  searchLevel: "none",
  reason: "router would defer",
  userNotice: null,
  queries: [],
});

const CANNED_WEB_4 = JSON.stringify({
  searchLevel: "web",
  reason: "latest evaluation needed",
  userNotice: "最新の評価やレビューをWebで確認します。",
  queries: [
    "GLM5.2 評価 最新 レビュー",
    "GLM5.2 review rating benchmark",
    "GLM-5.2 性能 比較",
    "GLM5.2 evaluation latest",
  ],
});

const CANNED_WIKI_2 = JSON.stringify({
  searchLevel: "wiki",
  reason: "named entity lookup",
  userNotice: "Wikipediaで調べます。",
  queries: ["アインシュタイン", "Albert Einstein"],
});

const FIXTURES: Fixture[] = [
  { id: "none-code", input: "Pythonのリスト内包表記を教えて", locale: "ja", canned: CANNED_NONE },
  { id: "web-heuristic", input: "PMR2.0のSteam評価は？最新のレビュー", locale: "ja", canned: CANNED_NONE },
  { id: "wiki-cjk", input: "Bunって何？", locale: "ja", canned: CANNED_NONE },
  { id: "wiki-ascii", input: "tRPCとは", locale: "ja", canned: CANNED_NONE },
  { id: "web-llm", input: "最新のGLM5.2の評価どう？", locale: "ja", canned: CANNED_WEB_4 },
  { id: "wiki-llm", input: "アインシュタインについて教えて", locale: "ja", canned: CANNED_WIKI_2 },
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
    const decision = await decideSearch(fx.input, "umans-glm-5.2", fx.locale, [], client as never);
    decisions.push({ id: fx.id, decision });
  }

  // Only search decisions (web + wiki) contribute to query metrics.
  const searchDecisions = decisions.filter((d) => d.decision.searchLevel !== "none");
  const allQueries = searchDecisions.flatMap((d) => d.decision.queries);

  const totalQueries = allQueries.length;
  const avgPerSearch = searchDecisions.length === 0 ? 0 : totalQueries / searchDecisions.length;
  const webQueries = searchDecisions
    .filter((d) => d.decision.searchLevel === "web")
    .flatMap((d) => d.decision.queries).length;
  const wikiQueries = searchDecisions
    .filter((d) => d.decision.searchLevel === "wiki")
    .flatMap((d) => d.decision.queries).length;

  // dual_lang_coverage: fraction of search decisions with >=1 non-CJK (English)
  // query AND >=1 CJK/locale-matching query.
  let dualLang = 0;
  for (const d of searchDecisions) {
    const hasNonCjk = d.decision.queries.some((q) => !CJK_RE.test(q) && ASCII_RE.test(q));
    const hasCjk = d.decision.queries.some((q) => CJK_RE.test(q));
    if (hasNonCjk && hasCjk) dualLang++;
  }
  const dualLangCoverage = searchDecisions.length === 0 ? 0 : dualLang / searchDecisions.length;

  // query_diversity: mean pairwise Jaccard distance within each decision, averaged.
  let diversitySum = 0;
  for (const d of searchDecisions) {
    const qs = d.decision.queries;
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
      `[bench] ${d.id}: level=${d.decision.searchLevel} queries=[${d.decision.queries.map((q) => `"${q}"`).join(", ")}]\n`,
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
