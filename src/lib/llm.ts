import OpenAI from "openai";

/** Hardcoded UmansAI API base URL. */
const UMANS_BASE_URL = "https://api.code.umans.ai/v1";

/**
 * UmansAI client. Provider is fixed to UmansAI (no longer configurable).
 * Only LLM_API_KEY needs to be set in .env.
 */
/**
 * Per-request HTTP timeout for the LLM client.
 * High-thinking models (e.g. GLM-5.2) + tool rounds often exceed 2 minutes on
 * a single stream; default is 5 minutes. Override with LLM_TIMEOUT_MS.
 */
export function llmTimeoutMs(): number {
  const v = Number(process.env.LLM_TIMEOUT_MS);
  return v > 0 ? v : 300_000;
}

export function createLLM() {
  return new OpenAI({
    baseURL: UMANS_BASE_URL,
    apiKey: process.env.LLM_API_KEY ?? "missing",
    timeout: llmTimeoutMs(),
    maxRetries: 1,
  });
}

export function defaultModel(): string {
  return process.env.LLM_MODEL ?? "umans-glm-5.2";
}

/** Model used for search query generation and summarization. Defaults to umans-qwen3.6-35b-a3b. */
export function defaultSearchModel(): string {
  return process.env.WEB_SEARCH_MODEL || "umans-qwen3.6-35b-a3b";
}

/**
 * Thinking effort for the search/summarize model.
 * Falls back to "none" (fastest) since search summarization does not need deep reasoning.
 */
export function searchThinkingEffort(): string {
  return process.env.WEB_SEARCH_THINKING_EFFORT || "none";
}

export function embedModel(): string {
  return process.env.EMBED_MODEL ?? "text-embedding-3-small";
}

/** Fallback model id. Returns null if LLM_FALLBACK_MODEL is unset (fallback disabled). */
export function fallbackModel(): string | null {
  const v = process.env.LLM_FALLBACK_MODEL;
  return v?.trim() || null;
}

/** TTFT timeout in milliseconds before falling back. Defaults to 10000 (10s). */
export function fallbackTimeoutMs(): number {
  const v = Number(process.env.LLM_FALLBACK_TIMEOUT_MS);
  return v > 0 ? v : 10_000;
}

/**
 * List of available models.
 * Returns the model list fetched from `/v1/models/info`. On API failure,
 * falls back to MODEL_REASONING (hardcoded values).
 */
export async function availableModels(): Promise<string[]> {
  const models = await getUmansModels();
  if (models.length > 0) return models.map((m) => m.id);
  return [defaultModel()];
}

/**
 * Reasoning effort definitions for each UmansAI model.
 * Based on capabilities.reasoning from API: https://api.code.umans.ai/v1/models/info
 * Models with an empty levels array cannot control reasoning intensity (no reasoning_effort sent).
 *
 * In production Umans mode, these are overridden by API responses. Kept as
 * fallback values for API fetch failure (user choice: keep current hardcoded values on fallback).
 */
export type ReasoningConfig = {
  levels: string[];
  defaultLevel: string | null;
  canDisable: boolean;
};

export const MODEL_REASONING: Record<string, ReasoningConfig> = {
  "umans-kimi-k2.6": { levels: [], defaultLevel: null, canDisable: false },
  "umans-kimi-k2.7": { levels: [], defaultLevel: null, canDisable: false },
  "umans-glm-5.1": { levels: ["none", "medium"], defaultLevel: "medium", canDisable: true },
  "umans-glm-5.2": { levels: ["none", "high", "max"], defaultLevel: "high", canDisable: true },
  "umans-coder": { levels: [], defaultLevel: null, canDisable: false },
  "umans-flash": { levels: ["none", "low", "medium", "high"], defaultLevel: "medium", canDisable: true },
  "umans-qwen3.6-35b-a3b": { levels: ["none", "low", "medium", "high"], defaultLevel: "medium", canDisable: true },
};

/**
 * Model information fetched from the UmansAPI /v1/models/info endpoint.
 */
export type UmansModelInfo = {
  id: string;
  displayName: string;
  reasoning: { levels: string[]; defaultLevel: string | null; canDisable: boolean };
  deprecated: boolean;
  replacement?: string;
};

// Fetched once at startup and cached in-process (user choice: fetch once at startup & cache).
let modelsInfoCache: UmansModelInfo[] | null = null;
let modelsInfoFetchPromise: Promise<UmansModelInfo[]> | null = null;

/** Call to discard the cache on config changes (when LLM_API_KEY / LLM_MODEL change). */
export function resetUmansModelsCache(): void {
  modelsInfoCache = null;
  modelsInfoFetchPromise = null;
}
/**
 * Fetches and caches model information from the UmansAPI /v1/models/info endpoint.
 * Fetches only once per process; subsequent calls return the cache.
 * On API failure, falls back to values built from MODEL_REASONING (hardcoded emergency fallback).
 */
export async function getUmansModels(): Promise<UmansModelInfo[]> {
  if (modelsInfoCache) return modelsInfoCache;
  if (modelsInfoFetchPromise) return modelsInfoFetchPromise;
  modelsInfoFetchPromise = fetchUmansModels();
  try {
    modelsInfoCache = await modelsInfoFetchPromise;
    return modelsInfoCache;
  } finally {
    modelsInfoFetchPromise = null;
  }
}

async function fetchUmansModels(): Promise<UmansModelInfo[]> {
  try {
    const res = await fetch(`${UMANS_BASE_URL}/models/info`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<
      string,
      {
        name: string;
        display_name?: string;
        capabilities?: {
          reasoning?: { levels?: string[]; default_level?: string | null; can_disable?: boolean };
        };
        deprecation?: { replacement?: string } | null;
      }
    >;
    return Object.values(data).map((m) => ({
      id: m.name,
      displayName: m.display_name ?? m.name,
      reasoning: {
        levels: m.capabilities?.reasoning?.levels ?? [],
        defaultLevel: m.capabilities?.reasoning?.default_level ?? null,
        canDisable: m.capabilities?.reasoning?.can_disable ?? false,
      },
      deprecated: Boolean(m.deprecation),
      replacement: m.deprecation?.replacement,
    }));
  } catch {
    // Fallback: build from the hardcoded MODEL_REASONING.
    return Object.entries(MODEL_REASONING).map(([id, cfg]) => ({
      id,
      displayName: id,
      reasoning: cfg,
      deprecated: false,
    }));
  }
}

/**
 * Returns the valid reasoning effort levels for the specified model.
 * Prefers API-sourced values; falls back to MODEL_REASONING on API failure.
 * Returns an empty array if the model is unknown or levels is empty (not controllable).
 */
export async function getReasoningLevels(model: string): Promise<string[]> {
  const models = await getUmansModels();
  const found = models.find((m) => m.id === model);
  if (found) return found.reasoning.levels;
  return MODEL_REASONING[model]?.levels ?? [];
}

/**
 * Returns the default reasoning effort for the specified model.
 * Prefers API-sourced values. Returns null for non-controllable models (empty levels / null defaultLevel).
 */
export async function getDefaultReasoningEffort(model: string): Promise<string | null> {
  const models = await getUmansModels();
  const found = models.find((m) => m.id === model);
  if (found) return found.reasoning.defaultLevel;
  return MODEL_REASONING[model]?.defaultLevel ?? null;
}

/**
 * Whether the specified model can fully disable thinking via enable_thinking: false.
 * Prefers the API-sourced can_disable flag.
 */
export async function canDisableThinking(model: string): Promise<boolean> {
  const models = await getUmansModels();
  const found = models.find((m) => m.id === model);
  if (found) return found.reasoning.canDisable;
  return MODEL_REASONING[model]?.canDisable ?? false;
}

/**
 * Builds request parameters to disable reasoning.
 * Priority:
 * 1. canDisable: true → enable_thinking: false (GLM-5.2 includes "none" in levels, but
 *    reasoning_effort: "none" is ignored, so enable_thinking takes precedence)
 * 2. levels includes "none" → reasoning_effort: "none"
 * 3. Neither possible → empty object (not controllable)
 *
 * Return type is relaxed to Record<string, unknown>, cast by the caller
 * to ChatCompletionCreateParams* types (enable_thinking is not in the SDK types).
 */
export async function buildDisableReasoningParams(
  model: string,
): Promise<Record<string, unknown>> {
  if (await canDisableThinking(model)) {
    return { enable_thinking: false };
  }
  const levels = await getReasoningLevels(model);
  if (levels.includes("none")) {
    return { reasoning_effort: "none" };
  }
  return {};
}

/** Mapping of model id → display_name. */
export async function getModelDisplayNames(): Promise<Record<string, string>> {
  const models = await getUmansModels();
  const map: Record<string, string> = {};
  for (const m of models) map[m.id] = m.displayName;
  return map;
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
};
