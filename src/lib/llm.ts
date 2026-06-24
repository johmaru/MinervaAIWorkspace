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
  return process.env.LLM_MODEL ?? "umans-glm-5.2";
}

/** 検索クエリ生成・要約に使うモデル。未設定時は umans-coder。 */
export function defaultSearchModel(): string {
  return process.env.WEB_SEARCH_MODEL || "umans-coder";
}

export function embedModel(): string {
  return process.env.EMBED_MODEL ?? "text-embedding-3-small";
}

/** LLM_BASE_URL が UmansAPI を指しているか（Umansモード）。 */
export function isUmansProvider(): boolean {
  const baseURL = process.env.LLM_BASE_URL ?? "";
  return baseURL.includes("api.code.umans.ai");
}

/**
 * 利用可能なモデル一覧。
 *
 * - Umansモード（LLM_BASE_URL が api.code.umans.ai を含む）:
 *   `/v1/models/info` から取得したモデル一覧を返す。API 失敗時は
 *   MODEL_REASONING（現行ハードコード）にフォールバック。
 * - OAI互換モード（OpenAI / vLLM / Ollama 等）:
 *   LLM_MODELS env（カンマ区切り）から構築。未設定時は defaultModel() のみ。
 */
export async function availableModels(): Promise<string[]> {
  if (isUmansProvider()) {
    const models = await getUmansModels();
    if (models.length > 0) return models.map((m) => m.id);
  }
  const raw = process.env.LLM_MODELS;
  if (!raw) return [defaultModel()];
  const models = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return models.length > 0 ? models : [defaultModel()];
}

/**
 * UmansAI 各モデルの reasoning effort 定義。
 * API: https://api.code.umans.ai/v1/models/info の capabilities.reasoning に基づく。
 * levels が空配列のモデルは思考強度を制御不能（reasoning_effort を送らない）。
 *
 * Umansモードの実稼働時は API 応答で上書きされる。これは API 取得失敗時の
 * フォールバック値として保持する（ユーザー選択: フォールバック時は現行ハードコードを残す）。
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
 * UmansAPI の /v1/models/info から取得したモデル情報。
 */
export type UmansModelInfo = {
  id: string;
  displayName: string;
  reasoning: { levels: string[]; defaultLevel: string | null };
  deprecated: boolean;
  replacement?: string;
};

// 起動時1回 fetch しプロセス内でキャッシュ（ユーザー選択: 起動時1回 fetch＆キャッシュ）。
let modelsInfoCache: UmansModelInfo[] | null = null;
let modelsInfoFetchPromise: Promise<UmansModelInfo[]> | null = null;

/** 設定変更時に呼んでキャッシュを破棄する（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_MODELS 変更時）。 */
export function resetUmansModelsCache(): void {
  modelsInfoCache = null;
  modelsInfoFetchPromise = null;
}

/**
 * UmansAPI の /v1/models/info からモデル情報を取得・キャッシュ。
 * プロセス内で1回だけ fetch し、以降はキャッシュを返す。
 * API 失敗時は MODEL_REASONING（現行ハードコード）から構築した値にフォールバック。
 *
 * Umansモードでない場合は空配列を返す（呼び出し元で OAI モード処理へ）。
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
  const baseURL = process.env.LLM_BASE_URL;
  if (!baseURL || !isUmansProvider()) {
    // Umansモードでない場合は空配列（呼び出し元で OAI モード処理へ）。
    return [];
  }
  try {
    const res = await fetch(`${baseURL}/models/info`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<
      string,
      {
        name: string;
        display_name?: string;
        capabilities?: {
          reasoning?: { levels?: string[]; default_level?: string | null };
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
      },
      deprecated: Boolean(m.deprecation),
      replacement: m.deprecation?.replacement,
    }));
  } catch {
    // フォールバック: 現行ハードコード MODEL_REASONING から構築。
    return Object.entries(MODEL_REASONING).map(([id, cfg]) => ({
      id,
      displayName: id,
      reasoning: cfg,
      deprecated: false,
    }));
  }
}

/**
 * 指定モデルの有効な reasoning effort レベル一覧を返す。
 * Umansモード時は API 由外の値を優先、それ以外は MODEL_REASONING を参照。
 * モデルが未知、または levels が空（制御不可）の場合は空配列を返す。
 */
export async function getReasoningLevels(model: string): Promise<string[]> {
  if (isUmansProvider()) {
    const models = await getUmansModels();
    const found = models.find((m) => m.id === model);
    if (found) return found.reasoning.levels;
  }
  return MODEL_REASONING[model]?.levels ?? [];
}

/**
 * 指定モデルのデフォルト reasoning effort を返す。
 * Umansモード時は API 由外の値を優先。制御不可モデル（levels 空 / defaultLevel null）は null。
 */
export async function getDefaultReasoningEffort(model: string): Promise<string | null> {
  if (isUmansProvider()) {
    const models = await getUmansModels();
    const found = models.find((m) => m.id === model);
    if (found) return found.reasoning.defaultLevel;
  }
  return MODEL_REASONING[model]?.defaultLevel ?? null;
}

/** モデル id → display_name のマッピング。OAIモード時は空オブジェクト。 */
export async function getModelDisplayNames(): Promise<Record<string, string>> {
  if (!isUmansProvider()) return {};
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
