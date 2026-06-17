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

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
