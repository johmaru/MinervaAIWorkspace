import type OpenAI from "openai";

/** チャット履歴のメッセージ形式（route.ts の DbMessage と構造的互換）。 */
export type DbMessage = {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
};

/**
 * テキストのトークン数をヒューリスティックで推定。
 * GLM/Qwen のトークナイザはクライアント側で利用不可なため、
 * CJK 文字 ≈ 1 token、その他 ≈ 4 chars/token で概算。
 * 保守的な過大見積もり（80%閾値の安全マージンとして機能）。
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
 * メッセージ配列の総トークン数を推定。
 * 各メッセージ +4 tokens overhead（role タグ・フォーマット）。
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
 * 会話履歴が長すぎる場合、古いメッセージを要約して圧縮する。
 * システム指示メッセージは要約対象外（呼び出し側が system メッセージを除外して渡す）。
 *
 * - history.length <= 6: そのまま返す（短すぎて要約不要）
 * - それ以外: 先頭 history.slice(0, -4) を要約、末尾4メッセージ(2ターン)は保持
 * - エラー時: 元の history をそのまま返す（チャットをブロックしない）
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
    console.error("[chat] compaction failed:", err);
    return history;
  }
}
