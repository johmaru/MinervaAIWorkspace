import type OpenAI from "openai";
import { defaultModel } from "@/lib/llm";

/**
 * モデルが function calling (tool use) を安定してサポートするかの判定結果。
 *
 * GLM-5.2 は `response_format` が不安定な実績があり、tool_calls も同様に
 * 不安定な可能性がある。そのため起動時に1回プローブして判定する。
 */
export type ToolSupport = {
  supported: boolean;
  checkedAt: Date;
};

let cached: ToolSupport | null = null;
let probePromise: Promise<ToolSupport> | null = null;

/** 設定変更時に呼んでキャッシュを破棄する（LLM 関連設定変更時）。 */
export function resetToolProbeCache(): void {
  cached = null;
  probePromise = null;
}

/**
 * ダミー検索ツール定義。プローブ用で実際には呼ばれないことを期待する。
 */
const PROBE_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web for information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
];

/**
 * モデルが function calling をサポートするかプローブする。
 *
 * プローブ内容: `tools` にダミー検索ツールを定義し、
 * "Return the string 'probe-ok' without calling any tool." というメッセージで
 * 1回 `chat.completions.create` を `stream:false` で呼ぶ。
 *
 * - `finish_reason==="stop"` かつ content に "probe-ok" → supported: true
 * - `tool_calls` が勝手に呼ばれた、またはエラー/タイムアウト → supported: false
 *
 * 結果はプロセス内キャッシュ（getUmansModels のパターンと同様）。
 * 起動時にバックグラウンドでプローブを開始し、`probeToolSupport` は
 * 結果が揃うまで `await` する設計。
 *
 * @param llm OpenAI クライアント
 * @param model モデル id（未指定時は defaultModel()）
 * @param client テスト注入用。未指定時は createLLM() — ただし llm が必須。
 */
export async function probeToolSupport(
  llm: OpenAI,
  model: string = defaultModel(),
): Promise<ToolSupport> {
  if (cached) return cached;
  if (probePromise) return probePromise;
  probePromise = runProbe(llm, model);
  try {
    cached = await probePromise;
    return cached;
  } finally {
    probePromise = null;
  }
}

async function runProbe(llm: OpenAI, model: string): Promise<ToolSupport> {
  try {
    const completion = await llm.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content:
            "Return the string 'probe-ok' without calling any tool. Do not call any function.",
        },
      ],
      tools: PROBE_TOOLS,
      stream: false,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

    const choice = completion.choices?.[0];
    if (!choice) return { supported: false, checkedAt: new Date() };

    // ツールが勝手に呼ばれた → サポート外（指示に従えない）
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      return { supported: false, checkedAt: new Date() };
    }

    if (choice.finish_reason === "stop") {
      const content = choice.message.content ?? "";
      if (content.includes("probe-ok")) {
        return { supported: true, checkedAt: new Date() };
      }
    }

    return { supported: false, checkedAt: new Date() };
  } catch {
    return { supported: false, checkedAt: new Date() };
  }
}
