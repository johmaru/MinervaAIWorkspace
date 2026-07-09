import type OpenAI from "openai";
import { createLLM, buildDisableReasoningParams } from "@/lib/llm";
import type { Locale } from "@/lib/i18n/types";
import { t } from "@/lib/i18n";

/**
 * Search decision router result.
 * Used to determine whether search is needed on the app side, without giving tools to the LLM.
 */
export type SearchDecision = {
  searchLevel: "none" | "wiki" | "web";
  reason: string;
  /** A short sentence displayed to the user as a heads-up. Null when no search is needed. */
  userNotice: string | null;
  /** 1–3 search queries. Matched to the user's language. */
  queries: string[];
};

const SYSTEM_PROMPT = `You are a search decision router.
Decide the search level for the user's message: "none", "wiki", or "web".
Do not answer the user. Return only valid JSON.

Use "wiki" when:
- the user asks about a named entity, historical figure, concept, or term you are uncertain about
- the user asks "what is X", "Xって何", "Xとは", "tell me about X" about a named entity
- the answer is stable factual/encyclopedic knowledge, not current/volatile info
- the user asks about a person's character, personality, reputation, or whether they really did something, even if phrased subjectively (e.g. "was X really a bad person?", "Xって性格悪かった？")
- Generate 1 query (the entity/term name in the user's language). If the entity name is not already in English, also generate a 2nd query with the English name or transliteration. This yields 1 or 2 queries.

Use "web" when:
- the user asks for latest/current/recent information
- prices, schedules, reviews, ratings, patches, release dates, laws, sports, news, products, or online population may have changed
- the user explicitly asks to look up/search/check/verify
- the answer depends on a specific website's current state
- the user mentions a specific product name, tool name, library, framework, or proper noun that may be unfamiliar or recently emerged (e.g. "omp", "Paseo", "Bun", "tRPC")
- Generate exactly 3 search queries in the user's language, each with a distinct role:
  1. Direct question: a natural-language question a person would type (e.g. "Project Motor Racing 2.0 Steam review")
  2. Keyword-focused: noun-phrase / entity keywords without grammar (e.g. "Project Motor Racing 2.0 review rating")
  3. Synonym/variant: the same intent with different terms or a broader scope (e.g. "PMR 2.0 評価 レビュー")
- If the user's language is not English, add one additional query in English (a direct translation of the keyword-focused query) to improve search-engine coverage. This yields 3 or 4 queries total.
- Each query must differ in wording, not just word order. Do not repeat a query verbatim.
- Do NOT use "web" for questions about a historical figure's or person's character, personality, or biography — use "wiki" instead

Use "none" when:
- the user asks for explanation, translation, coding help, general advice, brainstorming, or opinions
- the answer can be given from stable knowledge you are confident about
- the user is asking about provided text/code/logs
- the user asks about past conversations, memories, or what was previously discussed
- the entity is a well-known general concept that the model confidently knows (e.g. "what is Python", "what is HTTP") — only search when uncertain

If both "wiki" and "web" seem applicable, choose "web" — EXCEPT when the question is about stable biographical or historical facts about a person/entity (character, personality, biography, actions), in which case choose "wiki".

The userNotice should be a SHORT status-style sentence in the user's language (e.g. "最新の情報をWebで確認します。"). If search level is "none", set userNotice to null.

Return JSON:
{"searchLevel": "none" | "wiki" | "web", "reason": string, "userNotice": string | null, "queries": string[]}`;


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
      queries,
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

  // queries[0]: the original normalized user message (direct intent).
  // queries[1]: a keyword-focused variant — strip common Japanese particles
  //   and append a volatility keyword from the matched VOLATILE_INFO_PATTERN
  //   so the keyword query targets the changing facet. Reuses existing regex
  //   matching; no new tokenizer.
  const keywordVariant = normalized
    .replace(/[のはがをにでと]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const volatilityMatch = normalized.match(VOLATILE_INFO_PATTERN);
  const volatilityKeyword = volatilityMatch?.[0] ?? "";
  const keywordQuery = [keywordVariant, volatilityKeyword, "最新"]
    .filter((p) => p.length > 0)
    .join(" ");

  return {
    searchLevel: "web",
    reason: "heuristic: user requested current or volatile information",
    userNotice: buildUserNotice(normalized, true, locale),
    queries: [normalized, keywordQuery],
  };
}

function normalizeDecisionNotice(decision: SearchDecision, userMessage: string, locale: Locale): SearchDecision {
  if (decision.searchLevel === "none") return decision;
  return {
    ...decision,
    userNotice: buildUserNotice(userMessage, false, locale),
  };
}

/**
 * Parses SearchDecision from the LLM's raw response.
 * Returns null on invalid input; the caller decides retry/fallback.
 */
function parseDecision(raw: string | null | undefined): SearchDecision | null {
  if (!raw || !raw.trim()) return null;
  // GLM-5.2 may wrap JSON in markdown code fences
  // (```json ... ```) without response_format, so remove fences before parsing.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as Partial<SearchDecision>;
    return {
      searchLevel: parsed.searchLevel === "wiki" ? "wiki" : parsed.searchLevel === "web" ? "web" : "none",
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      userNotice:
        typeof parsed.userNotice === "string" && parsed.userNotice.trim()
          ? parsed.userNotice
          : null,
      queries: Array.isArray(parsed.queries)
        ? parsed.queries.filter(
            (q): q is string => typeof q === "string" && q.trim().length > 0,
          )
        : [],
    };
  } catch {
    return null;
  }
}

/** Builds the messages to send to the LLM in decideSearch. */
function buildMessages(
  userMessage: string,
  history: { role: string; content: string }[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];
}

/**
 * Determines whether search is needed based on the user's message.
 * Does not give tools to the LLM; only returns JSON (prompt emphasizes "Return only JSON").
 *
 * GLM-5.2 has unstable support for `response_format: { type: "json_object" }`
 * (empty content or timeouts occur), so response_format is not used; instead,
 * JSON is obtained via a regular completion and parsed after removing markdown code fences.
 *
 * On LLM error or JSON parse failure, falls back to searchLevel: "none" (normal chat).
 *
 * @param userMessage Latest user message
 * @param model LLM model id
 * @param locale User's locale (used for i18n of notification text)
 * @param history Past messages (role is "user" | "assistant")
 * @param client For test injection. If unspecified, createLLM() is used.
 */
export async function decideSearch(
  userMessage: string,
  model: string,
  locale: Locale,
  history: { role: string; content: string }[],
  client?: OpenAI,
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
  try {
    const disableParams = await buildDisableReasoningParams(model);
    const completion = await llm.chat.completions.create({
      model,
      messages: buildMessages(userMessage, history),
      // Do not use response_format: unstable on GLM-5.2 (empty content/timeout).
      // Emphasize "Return only JSON" in the prompt and parse after removing fences.
      // Search decision is a simple JSON output task, so disable thinking tokens to prevent
      // latency increase from Qwen3.6's medium thinking mode.
      // canDisable models fully turn off thinking via enable_thinking: false; others suppress
      // thinking via reasoning_effort: "none" (buildDisableReasoningParams auto-selects).
      ...disableParams,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    const parsed = parseDecision(completion.choices[0]?.message?.content);
    if (parsed) {
      if (parsed.searchLevel === "none" && heuristicDecision) return heuristicDecision;
      return normalizeDecisionNotice(parsed, userMessage, locale);
    }

    // Even on parse failure, inputs explicitly requesting latest/search/review are routed to search.
    return heuristicDecision ?? {
      searchLevel: "none",
      reason: "router failed",
      userNotice: null,
      queries: [],
    };
  } catch {
    // Even on LLM error, inputs explicitly requesting latest/search/review are routed to search.
    return heuristicDecision ?? {
      searchLevel: "none",
      reason: "router failed",
      userNotice: null,
      queries: [],
    };
  }
}
