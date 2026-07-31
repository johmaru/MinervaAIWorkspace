import OpenAI from "openai";

/** Default UmansAI API base URL (used when LLM_BASE_URL is unset). */
export const UMANS_BASE_URL = "https://api.code.umans.ai/v1";

export type LlmProvider = "openai" | "cursor";

/**
 * Active LLM provider from env.
 * - openai: OpenAI-compatible Chat Completions (UmansAI or any baseURL)
 * - cursor: @cursor/sdk billed to Cursor account usage
 */
export function llmProvider(): LlmProvider {
  const v = (process.env.LLM_PROVIDER || "openai").trim().toLowerCase();
  return v === "cursor" ? "cursor" : "openai";
}

/** Resolved OpenAI-compatible base URL (never empty). */
export function llmBaseUrl(): string {
  const raw = process.env.LLM_BASE_URL?.trim();
  return raw || UMANS_BASE_URL;
}

/** True when the configured base URL is the UmansAI endpoint. */
export function isUmansBaseUrl(baseUrl: string = llmBaseUrl()): boolean {
  try {
    const a = new URL(baseUrl);
    const b = new URL(UMANS_BASE_URL);
    return a.origin === b.origin;
  } catch {
    return baseUrl.replace(/\/$/, "") === UMANS_BASE_URL.replace(/\/$/, "");
  }
}

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
    baseURL: llmBaseUrl(),
    apiKey: process.env.LLM_API_KEY ?? "missing",
    timeout: llmTimeoutMs(),
    maxRetries: 1,
  });
}

export function defaultModel(): string {
  if (llmProvider() === "cursor") {
    return process.env.LLM_MODEL ?? "composer-2.5";
  }
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
 * List of available models for the active provider.
 */
export async function availableModels(): Promise<string[]> {
  if (llmProvider() === "cursor") {
    const { listCursorModels } = await import("./cursorLlm");
    const models = await listCursorModels();
    if (models.length > 0) return models.map((m) => m.id);
    return [defaultModel()];
  }
  const models = await getProviderModels();
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

/** Generic OpenAI-compatible reasoning levels when the provider does not advertise capabilities. */
export const DEFAULT_REASONING_LEVELS: readonly string[] = [
  "none",
  "low",
  "medium",
  "high",
  "max",
];

export function defaultReasoningConfig(): ReasoningConfig {
  return {
    levels: [...DEFAULT_REASONING_LEVELS],
    defaultLevel: "medium",
    canDisable: false,
  };
}

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
 * Model information from the provider catalog.
 */
export type UmansModelInfo = {
  id: string;
  displayName: string;
  reasoning: { levels: string[]; defaultLevel: string | null; canDisable: boolean };
  deprecated: boolean;
  replacement?: string;
};

// Fetched once at startup and cached in-process.
let modelsInfoCache: UmansModelInfo[] | null = null;
let modelsInfoFetchPromise: Promise<UmansModelInfo[]> | null = null;

/** Call to discard the cache on config changes (when LLM_* / CURSOR_* change). */
export function resetUmansModelsCache(): void {
  modelsInfoCache = null;
  modelsInfoFetchPromise = null;
}

/** @deprecated Alias kept for call sites; clears the shared models cache. */
export const resetModelsCache = resetUmansModelsCache;

/**
 * Fetches and caches model information for the openai provider.
 * Umans base → `/models/info`; otherwise OpenAI-compatible `/models`.
 */
export async function getUmansModels(): Promise<UmansModelInfo[]> {
  return getProviderModels();
}

export async function getProviderModels(): Promise<UmansModelInfo[]> {
  if (modelsInfoCache) return modelsInfoCache;
  if (modelsInfoFetchPromise) return modelsInfoFetchPromise;
  modelsInfoFetchPromise = fetchProviderModels();
  try {
    modelsInfoCache = await modelsInfoFetchPromise;
    return modelsInfoCache;
  } finally {
    modelsInfoFetchPromise = null;
  }
}

async function fetchProviderModels(): Promise<UmansModelInfo[]> {
  const base = llmBaseUrl();
  if (isUmansBaseUrl(base)) {
    return fetchUmansModelsInfo(base);
  }
  return fetchOpenAICompatibleModels(base);
}

async function fetchUmansModelsInfo(base: string): Promise<UmansModelInfo[]> {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/models/info`, {
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
    return Object.entries(MODEL_REASONING).map(([id, cfg]) => ({
      id,
      displayName: id,
      reasoning: cfg,
      deprecated: false,
    }));
  }
}

async function fetchOpenAICompatibleModels(base: string): Promise<UmansModelInfo[]> {
  try {
    const apiKey = process.env.LLM_API_KEY ?? "";
    const res = await fetch(`${base.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = (data.data ?? []).map((m) => m.id).filter(Boolean);
    if (ids.length === 0) throw new Error("empty model list");
    return ids.map((id) => ({
      id,
      displayName: id,
      reasoning: MODEL_REASONING[id] ?? defaultReasoningConfig(),
      deprecated: false,
    }));
  } catch {
    const id = defaultModel();
    return [
      {
        id,
        displayName: id,
        reasoning: MODEL_REASONING[id] ?? defaultReasoningConfig(),
        deprecated: false,
      },
    ];
  }
}

/**
 * Returns the valid reasoning effort levels for the specified model.
 * Prefers API-sourced values; falls back to MODEL_REASONING, then
 * DEFAULT_REASONING_LEVELS for freeform / OpenAI-compatible models without metadata.
 * Returns an empty array only when the catalog (or MODEL_REASONING) marks the model
 * as not controllable (e.g. umans-coder), or when provider is cursor.
 */
export async function getReasoningLevels(model: string): Promise<string[]> {
  if (llmProvider() === "cursor") return [];
  const models = await getProviderModels();
  const found = models.find((m) => m.id === model);
  if (found) {
    if (found.reasoning.levels.length > 0) return found.reasoning.levels;
    // Empty catalog levels: Umans /models/info is authoritative (not controllable).
    if (isUmansBaseUrl()) return [];
    if (model in MODEL_REASONING) return MODEL_REASONING[model].levels;
    return [...DEFAULT_REASONING_LEVELS];
  }
  if (model in MODEL_REASONING) return MODEL_REASONING[model].levels;
  return [...DEFAULT_REASONING_LEVELS];
}

/**
 * Returns the default reasoning effort for the specified model.
 * Prefers API-sourced values. Returns null for non-controllable models (empty levels / null defaultLevel).
 * Freeform / OpenAI-compatible models without metadata default to "medium".
 */
export async function getDefaultReasoningEffort(model: string): Promise<string | null> {
  if (llmProvider() === "cursor") return null;
  const models = await getProviderModels();
  const found = models.find((m) => m.id === model);
  if (found) {
    if (found.reasoning.levels.length > 0) return found.reasoning.defaultLevel;
    if (isUmansBaseUrl()) return null;
    if (model in MODEL_REASONING) return MODEL_REASONING[model].defaultLevel;
    return "medium";
  }
  if (model in MODEL_REASONING) return MODEL_REASONING[model].defaultLevel;
  return "medium";
}

/**
 * Whether the specified model can fully disable thinking via enable_thinking: false.
 * Prefers the API-sourced can_disable flag. Only meaningful for Umans models.
 */
export async function canDisableThinking(model: string): Promise<boolean> {
  if (llmProvider() === "cursor") return false;
  if (!isUmansBaseUrl() && !model.startsWith("umans-")) return false;
  const models = await getProviderModels();
  const found = models.find((m) => m.id === model);
  if (found) return found.reasoning.canDisable;
  return MODEL_REASONING[model]?.canDisable ?? false;
}

/**
 * Builds request parameters to disable reasoning (Umans-specific extras).
 */
export async function buildDisableReasoningParams(
  model: string,
): Promise<Record<string, unknown>> {
  if (!isUmansBaseUrl() && !model.startsWith("umans-")) {
    return {};
  }
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
  if (llmProvider() === "cursor") {
    const { listCursorModels } = await import("./cursorLlm");
    const models = await listCursorModels();
    const map: Record<string, string> = {};
    for (const m of models) map[m.id] = m.displayName;
    return map;
  }
  const models = await getProviderModels();
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
