import type OpenAI from "openai";
import { createLLM, buildDisableReasoningParams } from "@/lib/llm";
import type { Locale } from "@/lib/i18n/types";
import { t } from "@/lib/i18n";

/**
 * A single search query with an optional time range for SearXNG.
 */
export type SearchQuery = {
  query: string;
  time_range: "day" | "week" | "month" | "year" | null;
};

/**
 * Search decision router result.
 * Used to determine whether search is needed on the app side, without giving tools to the LLM.
 */
export type SearchDecision = {
  searchLevel: "none" | "wiki" | "web";
  reason: string;
  /** A short sentence displayed to the user as a heads-up. Null when no search is needed. */
  userNotice: string | null;
  /** 1–3 search queries with per-query time_range. Matched to the user's language. */
  queries: SearchQuery[];
};

// --- Phase A: Search-level judgment prompt ---

const JUDGE_PROMPT = `You are a search decision router.
Decide the search level for the user's message: "none", "wiki", or "web".
Do not answer the user. Return only valid JSON.

Use "wiki" when:
- the user asks about a named entity, historical figure, concept, or term you are uncertain about
- the user asks "what is X", "Xって何", "Xとは", "tell me about X" about a named entity
- the answer is stable factual/encyclopedic knowledge, not current/volatile info
- the user asks about a person's character, personality, reputation, or whether they really did something, even if phrased subjectively (e.g. "was X really a bad person?", "Xって性格悪かった？")

Use "web" when:
- the user asks for latest/current/recent information
- prices, schedules, reviews, ratings, patches, release dates, laws, sports, news, products, or online population may have changed
- the user explicitly asks to look up/search/check/verify
- the answer depends on a specific website's current state
- the user mentions a specific product name, tool name, library, framework, or proper noun that may be unfamiliar or recently emerged (e.g. "omp", "Paseo", "Bun", "tRPC")

Use "none" when:
- the user asks for explanation, translation, coding help, general advice, brainstorming, or opinions
- the answer can be given from stable knowledge you are confident about
- the user is asking about provided text/code/logs
- the user asks about past conversations, memories, or what was previously discussed
- the entity is a well-known general concept that the model confidently knows (e.g. "what is Python", "what is HTTP") — only search when uncertain

If both "wiki" and "web" seem applicable, choose "web" — EXCEPT when the question is about stable biographical or historical facts about a person/entity (character, personality, biography, actions), in which case choose "wiki".

The userNotice should be a SHORT status-style sentence in the user's language (e.g. "最新の情報をWebで確認します。"). If search level is "none", set userNotice to null.

Return JSON:
{"searchLevel": "none" | "wiki" | "web", "reason": string, "userNotice": string | null}`;

// --- Phase B: Query generation prompt ---

const QUERY_GEN_PROMPT = `You are a search query generator for SearXNG.
SearXNG uses keyword-based search engines (Bing, Mojang, DuckDuckGo).
Generate optimal search queries for the user's question.

CRITICAL RULES:
- Generate KEYWORD phrases, NOT natural-language questions.
  BAD: "Project Motor Racing 2.0 Steam review" (too verbose)
  GOOD: "Project Motor Racing 2.0 review rating" (keyword-focused)
- Use the CURRENT DATE from context when the question involves "today", "latest", "recent".
  Example: user asks "今日のAIニュース" with date 2026-07-11
  → query: "AI ニュース 2026年7月11日"
- time_range: "day" for today's news, "week" for recent, "month" for this month, null for stable info.
- Match the user's language for queries (Japanese queries for Japanese users).
- If the user's language is not English, add one English query.

For "web": generate 3 queries, each with a distinct role:
1. Keyword-focused with date if applicable (e.g. "AI ニュース 2026年7月11日", time_range: "day")
2. Broader keyword variant (e.g. "AI 最新ニュース", time_range: "week")
3. English variant (e.g. "AI news July 2026", time_range: "week")

For "wiki": generate 1-2 queries (entity name in user's language + English if non-English).
Wiki queries always have time_range: null.

Return JSON:
{"queries": [{"query": string, "time_range": "day"|"week"|"month"|"year"|null}]}`;


const EXPLICIT_SEARCH_PATTERN =
  /(web\s*search|search\s+the\s+web|look\s+up|verify|check\s+online|web検索|検索して|検索し|調べて|確認して|見て|最新|現在|直近|最近|いま|今日|latest|current|recent|today|up[- ]?to[- ]?date)/i;

const VOLATILE_INFO_PATTERN =
  /(steam|レビュー|評価|評判|口コミ|ratings?|reviews?|price|prices?|価格|値段|schedule|release|patch|update|version|人口|同接|ニュース|news|法律|law|sports?|score)/i;

const MEMORY_RECALL_PATTERN =
  /((何|なに).{0,6}(話|はなし))|((前|以前|さっき|昨日|きのう|前回|過去).{0,6}(話|はなし|会話|対話))|((覚|おぼ)えて)|(what (did|were) we (talk|discuss|chat))|(what we (talk|discuss))|((earlier|yesterday|before|just now|last time|previously|the other day|recently|last week|last night|earlier today).{0,10}(talk|conversation|discuss|chat))|(our (last|previous|recent|earlier) (talk|conversation|discuss|chat))|(remember (what|when|that|we|the|our))|(do you remember)|(previous (conversation|chat|discuss))/i;

/**
 * Pattern for queries about unknown concepts or named entities.
 * Matches "Xって何", "Xとは", "what is X", "tell me about X", "Xって良い/どう", etc.
 * MEMORY_RECALL_PATTERN takes precedence (memory recall questions do not search).
 */
const UNKNOWN_TERM_PATTERN =
  /((何|なに)は.{0,4}ですか)|(とは)|(って(何|なに|誰|だれ|何者|どんな|どういう|どうやって|なぜ|なんで|本当[に]?|ほんと[に]?|良い|いい|どう|どうですか|性格|人柄|人物|生涯|経歴|生い立ち|特徴|エピソード|実在))|(what (is|are|was|were) [A-Z])|(who (is|was|were) [A-Z])|(tell me about )|(was .{0,30} (really|actually|truly))|(did .{0,30} really (exist|live|do|happen))/i

/**
 * Patterns that clearly do not need search: code questions, translations, opinions, advice.
 * "解説" (explanation) is excluded because searching may be safer in some cases.
 * Only applies when none of EXPLICIT_SEARCH / VOLATILE_INFO / UNKNOWN_TERM match.
 */
const NO_SEARCH_PATTERN =
  /(コード|code|プログラム|program|翻訳|translate|翻して|どう思う|どう考える|意見|opinion|アドバイス|advice|アイデア|idea|ブレインストーム|brainstorm)/i;

/** Wraps a list of query strings into SearchQuery[] with time_range: null. */
function withTimeRangeNull(queries: string[]): SearchQuery[] {
  return queries.filter((q) => q.trim().length > 0).map((q) => ({ query: q, time_range: null }));
}

function buildUserNotice(userMessage: string, fallback: boolean, locale: Locale): string {
  if (fallback) return t(locale, "chat.noticeSearchFallback");
  if (/steam/i.test(userMessage)) return t(locale, "chat.noticeSearchSteam");
  if (/(レビュー|評価|評判|口コミ|ratings?|reviews?)/i.test(userMessage)) {
    return t(locale, "chat.noticeSearchReview");
  }
  if (UNKNOWN_TERM_PATTERN.test(userMessage)) return t(locale, "chat.noticeSearchWiki");
  return t(locale, "chat.noticeSearchDefault");
}

function buildHeuristicDecision(userMessage: string, locale: Locale): SearchDecision | null {
  const normalized = userMessage.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  // Memory recall questions ("何話した", "前に話した", "覚えてる", etc.) do not search.
  // Even if EXPLICIT_SEARCH_PATTERN matches "最近", "今日", etc., do not force search.
  if (MEMORY_RECALL_PATTERN.test(normalized)) return null;

  // Queries about unknown concepts or named entities ("Xって何", "Xとは", "what is X", etc.) search.
  // Memory recall questions are already excluded above.
  if (UNKNOWN_TERM_PATTERN.test(normalized)) {
    // Best-effort English variant: if the message is CJK but contains an ASCII
    // entity substring (e.g. "Bunって何？" -> "Bun"), use it as a 2nd query so
    // the English Wikipedia is attempted as a fallback. We cannot transliterate
    // pure-CJK entities without a library, so we do not fabricate one — the LLM
    // router is the primary path for English variants when it runs.
    const queries = [normalized];
    const cjk = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(normalized);
    if (cjk) {
      const asciiMatch = normalized.match(/[A-Za-z][A-Za-z0-9.\-]*[A-Za-z0-9]/);
      if (asciiMatch && asciiMatch[0].length >= 2) queries.push(asciiMatch[0]);
    }
    return {
      searchLevel: "wiki",
      reason: "heuristic: user asks about an unfamiliar named entity or term",
      userNotice: t(locale, "chat.noticeSearchWiki"),
      queries: withTimeRangeNull(queries),
    };
  }

  // Obviously non-search inputs (code/translation/opinion/advice, etc.) skip LLM judgment and
  // immediately return searchLevel:"none". Inputs that need search go to LLM judgment as before.
  if (!EXPLICIT_SEARCH_PATTERN.test(normalized) && !VOLATILE_INFO_PATTERN.test(normalized)) {
    if (NO_SEARCH_PATTERN.test(normalized)) {
      return {
        searchLevel: "none",
        reason: "heuristic: code/translation/opinion/advice request — no search needed",
        userNotice: null,
        queries: [],
      };
    }
    return null;
  }

  // Step 9: Improve heuristic fallback query quality.
  // queries[0]: keyword-focused variant — strip common Japanese particles/filler so
  //   SearXNG gets keyword-style input instead of the raw conversational sentence.
  // queries[1]: the original normalized user message (direct intent, as fallback).
  const baseKeywords = normalized
    .replace(/[のはがをにでとって？?！!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const volatilityMatch = normalized.match(VOLATILE_INFO_PATTERN);
  const volatilityKeyword = volatilityMatch?.[0] ?? "";
  const keywordQuery = [baseKeywords, volatilityKeyword, "最新"]
    .filter((p) => p.length > 0)
    .join(" ");

  return {
    searchLevel: "web",
    reason: "heuristic: user requested current or volatile information",
    userNotice: buildUserNotice(normalized, true, locale),
    queries: [
      { query: keywordQuery, time_range: null },
      { query: normalized, time_range: null },
    ],
  };
}

/**
 * Parses the Phase A (judge) LLM response.
 * Returns null on invalid input; the caller decides fallback.
 */
function parseJudgeDecision(raw: string | null | undefined): { searchLevel: "none" | "wiki" | "web"; reason: string; userNotice: string | null } | null {
  if (!raw || !raw.trim()) return null;
  // GLM-5.2 may wrap JSON in markdown code fences
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    const searchLevel = parsed.searchLevel === "wiki" ? "wiki" : parsed.searchLevel === "web" ? "web" : "none";
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    const userNotice =
      typeof parsed.userNotice === "string" && parsed.userNotice.trim()
        ? parsed.userNotice
        : null;
    return { searchLevel, reason, userNotice };
  } catch {
    return null;
  }
}

/**
 * Parses the Phase B (query generation) LLM response into SearchQuery[].
 * Returns null on invalid input; the caller decides fallback.
 */
function parseQueries(raw: string | null | undefined): SearchQuery[] | null {
  if (!raw || !raw.trim()) return null;
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    const rawQueries = parsed.queries;
    if (!Array.isArray(rawQueries)) return null;
    const validTimeRanges = new Set(["day", "week", "month", "year", null]);
    const queries: SearchQuery[] = [];
    for (const item of rawQueries) {
      if (item && typeof item === "object" && "query" in item) {
        const q = item.query;
        if (typeof q === "string" && q.trim().length > 0) {
          const tr = item.time_range;
          const timeRange = validTimeRanges.has(tr) ? tr : null;
          queries.push({ query: q.trim(), time_range: timeRange as SearchQuery["time_range"] });
        }
      } else if (typeof item === "string" && item.trim().length > 0) {
        // Backward compat: bare string queries
        queries.push({ query: item.trim(), time_range: null });
      }
    }
    return queries.length > 0 ? queries : null;
  } catch {
    return null;
  }
}

/** Builds the Phase A (judge) messages to send to the LLM. */
function buildJudgeMessages(
  userMessage: string,
  history: { role: string; content: string }[],
  envContext: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const systemContent = envContext ? `${JUDGE_PROMPT}\n\n${envContext}` : JUDGE_PROMPT;
  return [
    { role: "system", content: systemContent },
    ...history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];
}

/** Builds the Phase B (query generation) messages to send to the LLM. */
function buildQueryGenMessages(
  userMessage: string,
  searchLevel: "wiki" | "web",
  locale: Locale,
  envContext: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const systemContent = envContext ? `${QUERY_GEN_PROMPT}\n\n${envContext}` : QUERY_GEN_PROMPT;
  const localeHint = locale === "ja" ? "Japanese" : "English";
  return [
    { role: "system", content: systemContent },
    { role: "user", content: `Search level: ${searchLevel}\nUser language: ${localeHint}\nUser message: ${userMessage}` },
  ];
}

/**
 * Determines whether search is needed based on the user's message.
 * Does not give tools to the LLM; only returns JSON (prompt emphasizes "Return only JSON").
 *
 * Two-phase approach:
 * Phase A (judge): LLM decides searchLevel (none/wiki/web) — no queries generated.
 * Phase B (query gen): If searchLevel != none, LLM generates keyword-based queries
 * with per-query time_range. Skipped when heuristic short-circuits none/wiki.
 *
 * On LLM error or JSON parse failure, falls back to heuristicDecision.
 *
 * @param userMessage Latest user message
 * @param model LLM model id
 * @param locale User's locale (used for i18n of notification text)
 * @param history Past messages (role is "user" | "assistant")
 * @param client For test injection. If unspecified, createLLM() is used.
 * @param envContext Environment context string (current date/time) injected into system prompt
 */
export async function decideSearch(
  userMessage: string,
  model: string,
  locale: Locale,
  history: { role: string; content: string }[],
  client?: OpenAI,
  envContext: string = "",
): Promise<SearchDecision> {
  const heuristicDecision = buildHeuristicDecision(userMessage, locale);
  // If the heuristic determines "no search" or "Wikipedia lookup", skip the LLM call.
  // Code questions, translations, opinions, advice, etc. (none) go straight to normal chat.
  // Unknown concepts or named entities (wiki) go directly since Wikipedia lookup is lightweight and deterministic.
  // Explicit search requests or current-info requests (web) proceed to the LLM router for query refinement.
  if (heuristicDecision && (heuristicDecision.searchLevel === "none" || heuristicDecision.searchLevel === "wiki")) {
    return heuristicDecision;
  }
  const llm = client ?? createLLM();
  // buildDisableReasoningParams may fetch model capabilities; default to {} on failure
  // so that a fetch error doesn't crash decideSearch (caller has no try/catch).
  let disableParams: Record<string, unknown> = {};
  try {
    disableParams = await buildDisableReasoningParams(model);
  } catch {
    // Reasoning param fetch failed; proceed with default (no reasoning suppression)
  }

  // Phase A: Search-level judgment
  let searchLevel: "none" | "wiki" | "web";
  let judgeReason = "";
  let judgeUserNotice: string | null = null;
  try {
    const judgeCompletion = await llm.chat.completions.create({
      model,
      messages: buildJudgeMessages(userMessage, history, envContext),
      ...disableParams,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, {
      signal: AbortSignal.timeout(15_000),
    });
    const judgeResult = parseJudgeDecision(judgeCompletion.choices[0]?.message?.content);
    if (judgeResult) {
      searchLevel = judgeResult.searchLevel;
      judgeReason = judgeResult.reason;
      judgeUserNotice = judgeResult.userNotice;
    } else {
      // Parse failure: fall back to heuristic
      searchLevel = heuristicDecision?.searchLevel ?? "none";
    }
  } catch {
    // LLM error: fall back to heuristic
    searchLevel = heuristicDecision?.searchLevel ?? "none";
  }

  if (searchLevel === "none") {
    // Even on judge "none", inputs explicitly requesting latest/search/review use heuristic.
    if (heuristicDecision) return heuristicDecision;
    return {
      searchLevel: "none",
      reason: judgeReason || "router failed",
      userNotice: null,
      queries: [],
    };
  }

  // Phase B: Query generation (only when searchLevel != none)
  let queries: SearchQuery[] | null = null;
  try {
    const queryCompletion = await llm.chat.completions.create({
      model,
      messages: buildQueryGenMessages(userMessage, searchLevel, locale, envContext),
      ...disableParams,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, {
      signal: AbortSignal.timeout(15_000),
    });
    queries = parseQueries(queryCompletion.choices[0]?.message?.content);
  } catch {
    // Query gen error: fall back to heuristic queries
  }

  // For non-none search levels, always recompute userNotice from the user message
  // (matches old normalizeDecisionNotice behavior — LLM notice is discarded).
  const recomputedNotice = buildUserNotice(userMessage, false, locale);

  if (!queries || queries.length === 0) {
    // Fallback: heuristic queries if available, else raw userMessage
    if (heuristicDecision) return heuristicDecision;
    return {
      searchLevel,
      reason: judgeReason || "query gen fallback",
      userNotice: recomputedNotice,
      queries: [{ query: userMessage, time_range: null }],
    };
  }

  return {
    searchLevel,
    reason: judgeReason || (heuristicDecision?.reason ?? ""),
    userNotice: recomputedNotice,
    queries,
  };
}

