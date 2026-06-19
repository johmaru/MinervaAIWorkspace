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

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
};
