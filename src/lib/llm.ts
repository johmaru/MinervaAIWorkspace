import OpenAI from "openai";

/**
 * OpenAI 互換クライアント。
 * LLM_BASE_URL で UmansAI / OpenAI / ローカル (vLLM, Ollama 等) を切替。
 */
export function createLLM() {
  const baseURL = process.env.LLM_BASE_URL;
  if (!baseURL) {
    throw new Error("LLM_BASE_URL が未設定です。.env を確認してください。");
  }
  return new OpenAI({
    baseURL,
    apiKey: process.env.LLM_API_KEY ?? "missing",
  });
}

export function defaultModel(): string {
  return process.env.LLM_MODEL ?? "gpt-4o-mini";
}

export function embedModel(): string {
  return process.env.EMBED_MODEL ?? "text-embedding-3-small";
}

/**
 * 利用可能なモデル一覧。
 * LLM_MODELS env（カンマ区切り）から解析。未設定時は defaultModel() のみ。
 * 例: LLM_MODELS="umans-glm-5.2,gpt-4o-mini,gpt-4o"
 */
export function availableModels(): string[] {
  const raw = process.env.LLM_MODELS;
  if (!raw) return [defaultModel()];
  const models = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return models.length > 0 ? models : [defaultModel()];
}

/**
 * UmansAI 各モデルの reasoning effort 定義。
 * API: https://api.code.umans.ai/v1/models/info の capabilities.reasoning に基づく。
 * levels が空配列のモデルは思考強度を制御不能（reasoning_effort を送らない）。
 */
export type ReasoningConfig = {
  levels: string[];
  defaultLevel: string | null;
};

export const MODEL_REASONING: Record<string, ReasoningConfig> = {
  "umans-kimi-k2.6": { levels: [], defaultLevel: null },
  "umans-kimi-k2.7": { levels: [], defaultLevel: null },
  "umans-glm-5.1": { levels: ["none", "medium"], defaultLevel: "medium" },
  "umans-glm-5.2": { levels: ["none", "high", "max"], defaultLevel: "high" },
  "umans-coder": { levels: [], defaultLevel: null },
  "umans-flash": { levels: ["none", "low", "medium", "high"], defaultLevel: "medium" },
  "umans-qwen3.6-35b-a3b": { levels: ["none", "low", "medium", "high"], defaultLevel: "medium" },
};

/**
 * 指定モデルの有効な reasoning effort レベル一覧を返す。
 * モデルが未知、または levels が空（制御不可）の場合は空配列を返す。
 */
export function getReasoningLevels(model: string): string[] {
  return MODEL_REASONING[model]?.levels ?? [];
}

/**
 * 指定モデルのデフォルト reasoning effort を返す。
 * 制御不可モデル（levels 空 / defaultLevel null）の場合は null。
 */
export function getDefaultReasoningEffort(model: string): string | null {
  return MODEL_REASONING[model]?.defaultLevel ?? null;
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
};
