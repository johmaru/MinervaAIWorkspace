import type OpenAI from "openai";
import { logger } from "@/lib/logger";

/** Chat history message format (structurally compatible with DbMessage in route.ts). */
export type DbMessage = {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
};

/**
 * Heuristically estimates the token count of a text.
 * GLM/Qwen tokenizers are unavailable client-side, so this approximates
 * CJK characters ≈ 1 token, others ≈ 4 chars/token.
 * Conservative overestimate (acts as safety margin for the 80% threshold).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // CJK Unified Ideographs, Hiragana, Katakana, CJK Symbols, Halfwidth/Fullwidth Forms
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 1.0 + other / 4.0);
}

/**
 * Estimates the total token count of a message array.
 * Each message adds +4 tokens overhead (role tags, formatting).
 */
export function estimateMessagesTokens(
  messages: { role: string; content: string }[],
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4;
  }
  return total;
}

/**
 * When conversation history is too long, summarizes older messages to compact it.
 * System instruction messages are excluded from summarization (caller filters out system messages).
 *
 * - history.length <= 6: return as-is (too short to summarize)
 * - otherwise: summarize history.slice(0, -4), keep the last 4 messages (2 turns)
 * - on error: return the original history as-is (does not block chat)
 */
export async function compactHistory({
  history,
  llm,
  model,
}: {
  history: DbMessage[];
  llm: OpenAI;
  model: string;
}): Promise<DbMessage[]> {
  if (history.length <= 6) return history;

  const toSummarize = history.slice(0, -4);
  const recent = history.slice(-4);

  const formatted = toSummarize
    .map((m) => {
      const speaker = m.role === "user" ? "ユーザー" : "アシスタント";
      return `${speaker}: ${m.content}`;
    })
    .join("\n\n");

  const summaryPrompt = `以下の会話履歴を要約してください。重要な情報、決定事項、ユーザーの意図と嗜好、議論の文脈を保持してください。簡潔に、しかし情報を漏らさないようにしてください。システム指示やプロンプト設定は含めないでください。

## 会話履歴
${formatted}`;

  try {
    const completion = await llm.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "あなたは会話要約アシスタントです。" },
        { role: "user", content: summaryPrompt },
      ],
      stream: false,
      max_tokens: 1024,
      temperature: 0.3,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

    const summary =
      completion.choices?.[0]?.message?.content?.trim() ?? "(要約なし)";

    const summaryMsg: DbMessage = {
      id: "compacted-summary",
      parentId: null,
      role: "system",
      content: `## 過去の会話要約\n${summary}`,
    };

    return [summaryMsg, ...recent];
  } catch (err) {
    logger.error("chat", "compaction failed", { error: err instanceof Error ? err.message : String(err) });
    return history;
  }
}
