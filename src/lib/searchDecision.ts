import type OpenAI from "openai";
import { createLLM, buildDisableReasoningParams } from "@/lib/llm";

/**
 * 検索判定ルーターの結果。
 * LLM にツールを持たせず、アプリ側で検索要否を判定するために使う。
 */
export type SearchDecision = {
  needsSearch: boolean;
  reason: string;
  /** ユーザーへ一言断りとして表示する短い文。検索不要時は null。 */
  userNotice: string | null;
  /** 1〜3の検索クエリ。ユーザー言語に合わせる。 */
  queries: string[];
};

const SYSTEM_PROMPT = `You are a search decision router.
Decide whether the user's message requires web search before answering.
Do not answer the user. Return only valid JSON.

Use web search when:
- the user asks for latest/current/recent information
- prices, schedules, reviews, ratings, patches, release dates, laws, sports, news, products, or online population may have changed
- the user explicitly asks to look up/search/check/verify
- the answer depends on a specific website's current state
- the user mentions a specific product name, tool name, library, framework, or proper noun that may be unfamiliar or recently emerged (e.g. "omp", "Paseo", "Bun", "tRPC")
- the user asks "what is X", "Xって何", "Xとは", "tell me about X" about a named entity

Do not use web search when:
- the user asks for explanation, translation, coding help, general advice, brainstorming, or opinions
- the answer can be given from stable knowledge
- the user is asking about provided text/code/logs
- the user asks about past conversations, memories, or what was previously discussed
- the entity is a well-known general concept that the model confidently knows (e.g. "what is Python", "what is HTTP") — only search when uncertain

If search is needed, create 2 to 3 precise search queries in the user's language.
Use different phrasings or aspects of the question for each query (e.g. a direct question, a keyword-focused query, and a variant with synonyms). This improves result coverage across search engines.
The userNotice should be a SHORT status-style sentence in the user's language (e.g. "最新の情報をWebで確認します。"). If no search needed, set userNotice to null.

Return JSON:
{"needsSearch": boolean, "reason": string, "userNotice": string | null, "queries": string[]}`;

const FALLBACK_USER_NOTICE = "検索判定を定型ルールで補完し、Webで最新情報を確認します。";
const DEFAULT_USER_NOTICE = "最新の情報をWebで確認します。";
const REVIEW_USER_NOTICE = "最新の評価やレビューをWebで確認します。";
const STEAM_USER_NOTICE = "Steamの最新情報をWebで確認します。";
const UNKNOWN_TERM_NOTICE = "未知の語についてWebで調べます。";

const EXPLICIT_SEARCH_PATTERN =
  /(web\s*search|search\s+the\s+web|look\s+up|verify|check\s+online|web検索|検索して|検索し|調べて|確認して|見て|最新|現在|直近|最近|いま|今日|latest|current|recent|today|up[- ]?to[- ]?date)/i;

const VOLATILE_INFO_PATTERN =
  /(steam|レビュー|評価|評判|口コミ|ratings?|reviews?|price|prices?|価格|値段|schedule|release|patch|update|version|人口|同接|ニュース|news|法律|law|sports?|score)/i;

const MEMORY_RECALL_PATTERN =
  /((何|なに).{0,6}(話|はなし))|((前|以前|さっき|昨日|きのう|前回|過去).{0,6}(話|はなし|会話|対話))|((覚|おぼ)えて)|(what (did|were) we (talk|discuss|chat))|(what we (talk|discuss))|((earlier|yesterday|before|just now|last time|previously|the other day|recently|last week|last night|earlier today).{0,10}(talk|conversation|discuss|chat))|(our (last|previous|recent|earlier) (talk|conversation|discuss|chat))|(remember (what|when|that|we|the|our))|(do you remember)|(previous (conversation|chat|discuss))/i;

/**
 * 未知概念・固有名詞への問い合わせパターン。
 * 「Xって何」「Xとは」「what is X」「tell me about X」「Xって良い/どう」等。
 * MEMORY_RECALL_PATTERN が優先される（記憶呼び出し質問は検索しない）。
 */
const UNKNOWN_TERM_PATTERN =
  /((何|なに)は.{0,4}ですか)|(とは)|(って(何|なに))|(what (is|are) [A-Z])|(tell me about )|(って(良い|いい|どう|どうですか))/i;

/**
 * 明らかに検索不要なパターン: コード質問、翻訳、意見、アドバイス。
 * 「解説」は検索した方が安心なケースがあるため含めない。
 * EXPLICIT_SEARCH / VOLATILE_INFO / UNKNOWN_TERM のいずれにもマッチしない場合のみ適用。
 */
const NO_SEARCH_PATTERN =
  /(コード|code|プログラム|program|翻訳|translate|翻して|どう思う|どう考える|意見|opinion|アドバイス|advice|アイデア|idea|ブレインストーム|brainstorm)/i;

function buildUserNotice(userMessage: string, fallback: boolean): string {
  if (fallback) return FALLBACK_USER_NOTICE;
  if (/steam/i.test(userMessage)) return STEAM_USER_NOTICE;
  if (/(レビュー|評価|評判|口コミ|ratings?|reviews?)/i.test(userMessage)) {
    return REVIEW_USER_NOTICE;
  }
  if (UNKNOWN_TERM_PATTERN.test(userMessage)) return UNKNOWN_TERM_NOTICE;
  return DEFAULT_USER_NOTICE;
}

function buildHeuristicDecision(userMessage: string): SearchDecision | null {
  const normalized = userMessage.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  // 記憶呼び出し質問（「何話した」「前に話した」「覚えてる」等）は検索しない。
  // EXPLICIT_SEARCH_PATTERN の「最近」「今日」等にマッチしても強制検索しない。
  if (MEMORY_RECALL_PATTERN.test(normalized)) return null;

  // 未知概念・固有名詞への問い合わせ（「Xって何」「Xとは」「what is X」等）は検索。
  // 記憶呼び出し質問は上で除外済み。
  if (UNKNOWN_TERM_PATTERN.test(normalized)) {
    return {
      needsSearch: true,
      reason: "heuristic: user asks about an unfamiliar named entity or term",
      userNotice: UNKNOWN_TERM_NOTICE,
      queries: [normalized],
    };
  }

  // 明らかに検索不要な入力（コード/翻訳/意見/アドバイス等）は LLM 判定をスキップし、
  // 即座に needsSearch:false を返す。検索が必要な入力は従来通り LLM 判定へ。
  if (!EXPLICIT_SEARCH_PATTERN.test(normalized) && !VOLATILE_INFO_PATTERN.test(normalized)) {
    if (NO_SEARCH_PATTERN.test(normalized)) {
      return {
        needsSearch: false,
        reason: "heuristic: code/translation/opinion/advice request — no search needed",
        userNotice: null,
        queries: [],
      };
    }
    return null;
  }

  const queryParts = [normalized];
  if (/steam/i.test(normalized) && !/(レビュー|評価|review|rating)/i.test(normalized)) {
    queryParts.push("Steam レビュー 評価");
  }
  if (/(レビュー|評価|評判|ratings?|reviews?)/i.test(normalized) && !/steam/i.test(normalized)) {
    queryParts.push("レビュー 評価 最新");
  }

  return {
    needsSearch: true,
    reason: "heuristic: user requested current or volatile information",
    userNotice: buildUserNotice(normalized, true),
    queries: [queryParts.join(" ")],
  };
}

function normalizeDecisionNotice(decision: SearchDecision, userMessage: string): SearchDecision {
  if (!decision.needsSearch) return decision;
  return {
    ...decision,
    userNotice: buildUserNotice(userMessage, false),
  };
}

/**
 * LLM の生レスポンスから SearchDecision をパース。
 * 不正な場合は null を返し、呼び出し元でリトライ/フォールバックを判断する。
 */
function parseDecision(raw: string | null | undefined): SearchDecision | null {
  if (!raw || !raw.trim()) return null;
  // GLM-5.2 は response_format 無しで JSON を markdown コードフェンス
  // (```json ... ```) で包むことがあるため、フェンスを除去してからパース。
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as Partial<SearchDecision>;
    return {
      needsSearch: Boolean(parsed.needsSearch),
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

/** decideSearch で LLM に送る messages を構築。 */
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
 * ユーザー発言から検索要否を判定する。
 * LLM にツールを持たせず、JSON のみ返させる（プロンプトで "Return only JSON" を強調）。
 *
 * GLM-5.2 は `response_format: { type: "json_object" }` のサポートが不安定
 * （空内容やタイムアウトが発生する）ため、response_format を使わず通常の
 * completion で JSON を取得し、markdown コードフェンスを除去してパースする。
 *
 * LLM エラー・JSON パース失敗時は needsSearch: false でフォールバック（通常チャット）。
 *
 * @param userMessage 最新のユーザー発言
 * @param model LLM モデル id
 * @param history 過去メッセージ（role は "user" | "assistant"）
 * @param client テスト注入用。未指定時は createLLM()
 */
export async function decideSearch(
  userMessage: string,
  model: string,
  history: { role: string; content: string }[],
  client?: OpenAI,
): Promise<SearchDecision> {
  const heuristicDecision = buildHeuristicDecision(userMessage);
  // ヒューリスティックで「検索不要」が確定した場合は LLM 呼び出しをスキップ。
  // コード質問・翻訳・意見・アドバイス等、明らかに検索不要な入力のレイテンシを削減。
  if (heuristicDecision && !heuristicDecision.needsSearch) {
    return heuristicDecision;
  }
  const llm = client ?? createLLM();
  try {
    const disableParams = await buildDisableReasoningParams(model);
    const completion = await llm.chat.completions.create({
      model,
      messages: buildMessages(userMessage, history),
      // response_format は使わない: GLM-5.2 で不安定（空内容/タイムアウト）。
      // プロンプトで "Return only JSON" を強調し、フェンス除去でパースする。
      // 検索判定は単純なJSON出力タスクなので思考トークンを無効化し、
      // Qwen3.6 の medium 思考モードによるレイテンシ増加を防ぐ。
      // canDisable モデルは enable_thinking: false で完全OFF、それ以外は
      // reasoning_effort: "none" で思考を抑制（buildDisableReasoningParams が自動選択）。
      ...disableParams,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    const parsed = parseDecision(completion.choices[0]?.message?.content);
    if (parsed) {
      if (!parsed.needsSearch && heuristicDecision) return heuristicDecision;
      return normalizeDecisionNotice(parsed, userMessage);
    }

    // パース失敗時でも、明示的に最新/検索/評価を求める入力は検索へ倒す。
    return heuristicDecision ?? {
      needsSearch: false,
      reason: "router failed",
      userNotice: null,
      queries: [],
    };
  } catch {
    // LLM エラー時でも、明示的に最新/検索/評価を求める入力は検索へ倒す。
    return heuristicDecision ?? {
      needsSearch: false,
      reason: "router failed",
      userNotice: null,
      queries: [],
    };
  }
}
