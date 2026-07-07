import { readFileSync, writeFileSync } from "node:fs";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { users, memories, pageEmbeddings, skills } from "@/db/schema";
import { getRequestLocale, t } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/types";
import { resetUmansModelsCache } from "@/lib/llm";
import { resetToolProbeCache } from "@/lib/toolProbe";
import { getSessionUser } from "@/lib/auth-guards";
import { resetEmbedPipeline, embedText } from "@/lib/embed";
import { PERSONAL_STYLES } from "@/lib/personalization";
import { resolveEnvPath, updateEnvContent } from "@/lib/envUtils";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EmbedModelBase = {
  model: string;
  dim: number;
  provider: "local" | "http";
  labelKey: string;
};

/**
 * 埋め込みモデルの候補。
 * provider: "local" = transformers.js（ONNX）/ "http" = Python embedder サービス
 * label はロケールに応じて t() で翻訳される。
 */
const EMBED_MODEL_BASE: EmbedModelBase[] = [
  {
    model: "Xenova/all-MiniLM-L6-v2",
    dim: 384,
    provider: "local",
    labelKey: "settings.embedLabelMiniLM",
  },
  {
    model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    dim: 384,
    provider: "local",
    labelKey: "settings.embedLabelMultilingual",
  },
  {
    model: "Xenova/multilingual-e5-small",
    dim: 384,
    provider: "local",
    labelKey: "settings.embedLabelE5Small",
  },
  {
    model: "Xenova/multilingual-e5-base",
    dim: 768,
    provider: "local",
    labelKey: "settings.embedLabelE5Base",
  },
  {
    model: "LiquidAI/LFM2.5-Embedding-350M",
    dim: 1024,
    provider: "http",
    labelKey: "settings.embedLabelLFM2",
  },
];

/**
 * ロケールに応じた埋め込みモデル候補を返す。
 * label が翻訳される。テストからは EMBED_MODEL_BASE で構造検査可能。
 */
export function getEmbedModelOptions(locale: Locale) {
  return EMBED_MODEL_BASE.map((o) => ({ ...o, label: t(locale, o.labelKey) }));
}

/** テスト用: label 無しの構造 */
export { EMBED_MODEL_BASE };

/**
 * 現在の埋め込み次元を取得。
 * SQLite では embedding は JSON 配列（text 列）のため、次元は列型ではなく
 * 環境変数 EMBED_DIM から取得する。次元変更時は既存データをクリアする必要があるが、
 * 列の DDL は不要（text 列は任意次元の JSON を格納可能）。
 */
function getEmbedDim(): number {
  return Number(process.env.EMBED_DIM) || 1024;
}




/**
 * GET /api/settings — 現在の全設定 + 候補リストを返す。
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const locale = getRequestLocale(req);

  // ユーザー単位の設定を取得（DB）: 既定グローバルインストラクション + パーソナライズ
  const [userRow] = await db
    .select({
      activeInstructionId: users.activeInstructionId,
      personalStyle: users.personalStyle,
      personalWarmth: users.personalWarmth,
      personalEnergy: users.personalEnergy,
      personalStructure: users.personalStructure,
      personalEmoji: users.personalEmoji,
    })
    .from(users)
    .where(eq(users.id, user.id));

  return Response.json({
    // LLM
    llmBaseUrl: process.env.LLM_BASE_URL || "",
    // シークレットは平文で返さず、設定済みかどうかのみ返す。
    // SettingsModal はユーザーが新しい値を入力した場合のみ llmApiKey を送信し、
    // 未入力時は undefined を送ることで既存値を保持する。
    llmApiKey: "",
    hasLlmApiKey: !!process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL || "umans-glm-5.2",
    llmModels: process.env.LLM_MODELS || "",
    thinkingEffort: process.env.THINKING_EFFORT || "medium",
    // Embeddings
    embedModel: process.env.EMBED_MODEL || "LiquidAI/LFM2.5-Embedding-350M",
    embedDim: Number(process.env.EMBED_DIM) || 1024,
    embedProvider: process.env.EMBED_PROVIDER || "http",
    embedModelOptions: getEmbedModelOptions(locale),
    dbVectorDim: getEmbedDim(),
    dbPageEmbeddingsDim: getEmbedDim(),
    // Web 検索
    webSearchModel: process.env.WEB_SEARCH_MODEL || "umans-qwen3.6-35b-a3b",
    webSearchMaxResults: Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3,
    webSearchMaxRounds: Number(process.env.WEB_SEARCH_MAX_ROUNDS) || 2,
    scraperUrl: process.env.SCRAPER_URL || "http://localhost:8000",
    searxngUrl: process.env.SEARXNG_URL || "http://localhost:8080",
    // Tor プロキシ
    torProxy: process.env.TOR_PROXY || "",
    scrapeProxy: process.env.SCRAPE_PROXY || "",
    // Database / 実行環境
    databaseUrl: process.env.DATABASE_URL || "",
    hostOs: process.env.HOST_OS || "",
    tz: process.env.TZ || "",
    // Notion OAuth
    notionClientId: process.env.NOTION_CLIENT_ID || "",
    // シークレットは平文で返さず、設定済みかどうかのみ返す。
    notionClientSecret: "",
    hasNotionClientSecret: !!process.env.NOTION_CLIENT_SECRET,
    authUrl: process.env.AUTH_URL || "http://localhost:3001",
    // Cloudflare Tunnel — トークンは平文で返さず、設定済みかどうかのみ返す
    tunnelToken: "",
    hasTunnelToken: !!process.env.TUNNEL_TOKEN,
    // 既定グローバルインストラクション選択（ユーザー単位、DB）
    activeInstructionId: userRow?.activeInstructionId ?? null,
    // パーソナライズ（ユーザー単位、DB）
    personalStyle: userRow?.personalStyle ?? null,
    personalWarmth: userRow?.personalWarmth ?? 1,
    personalEnergy: userRow?.personalEnergy ?? 1,
    personalStructure: userRow?.personalStructure ?? 1,
    personalEmoji: userRow?.personalEmoji ?? 1,
  });
}

type SettingsBody = {
  // LLM
  llmBaseUrl?: string;
  llmApiKey?: string;
  // 既定グローバルインストラクション選択（ユーザー単位、DB に保存）
  activeInstructionId?: string | null;
  // パーソナライズ（ユーザー単位、DB に保存）
  personalStyle?: string | null;
  personalWarmth?: number;
  personalEnergy?: number;
  personalStructure?: number;
  personalEmoji?: number;
  llmModel?: string;
  llmModels?: string;
  thinkingEffort?: string;
  // Embeddings
  embedModel?: string;
  embedDim?: number;
  embedProvider?: string;
  // Web 検索
  webSearchModel?: string;
  webSearchMaxResults?: number;
  webSearchMaxRounds?: number;
  scraperUrl?: string;
  searxngUrl?: string;
  // Tor プロキシ
  torProxy?: string;
  scrapeProxy?: string;
  // Database
  databaseUrl?: string;
  // 実行環境
  hostOs?: string;
  tz?: string;
  // Notion OAuth
  notionClientId?: string;
  notionClientSecret?: string;
  authUrl?: string;
  // Cloudflare Tunnel
  tunnelToken?: string;
  applyMigration?: boolean;
};

/**
 * POST /api/settings — 全設定を .env に保存。
 *
 * embedModel の次元が変わる場合は applyMigration=true で vector 列を再作成。
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const locale = getRequestLocale(req);
  let body: SettingsBody;
  try {
    body = (await req.json()) as SettingsBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // バリデーション
  if (body.webSearchModel !== undefined && !/^[a-zA-Z0-9._-]+$/.test(body.webSearchModel)) {
    return new Response("webSearchModel must be alphanumeric (e.g. umans-coder, umans-glm-5.2)", { status: 400 });
  }

  if (body.embedDim && (body.embedDim < 1 || body.embedDim > 4096)) {
    return new Response("embedDim must be 1-4096", { status: 400 });
  }
  if (body.webSearchMaxResults && (body.webSearchMaxResults < 1 || body.webSearchMaxResults > 20)) {
    return new Response("webSearchMaxResults must be 1-20", { status: 400 });
  }
  if (body.webSearchMaxRounds !== undefined && (body.webSearchMaxRounds < 1 || body.webSearchMaxRounds > 5)) {
    return new Response("webSearchMaxRounds must be 1-5", { status: 400 });
  }
  if (body.thinkingEffort !== undefined && !/^[a-z0-9]+$/i.test(body.thinkingEffort)) {
    return new Response("thinkingEffort must be alphanumeric (e.g. none, low, medium, high, max)", { status: 400 });
  }

  // パーソナライズのバリデーション
  if (
    body.personalStyle !== undefined &&
    body.personalStyle !== null &&
    !PERSONAL_STYLES.includes(body.personalStyle as never)
  ) {
    return new Response("personalStyle must be one of the valid presets or null", { status: 400 });
  }
  const clampTrait = (v: number | undefined) =>
    v === undefined ? undefined : Math.max(0, Math.min(2, Math.trunc(v)));
  const clampedWarmth = clampTrait(body.personalWarmth);
  const clampedEnergy = clampTrait(body.personalEnergy);
  const clampedStructure = clampTrait(body.personalStructure);
  const clampedEmoji = clampTrait(body.personalEmoji);
  const dbVectorDim = getEmbedDim();

  // 新しい次元を決定
  const newDim = body.embedDim ?? dbVectorDim;
  // SQLite では embedding は text（JSON 配列）のため、次元変更に列 DDL は不要。
  // ただし異なるモデルのベクトル空間は互換しないため、次元が変わる場合は
  // 既存の embedding データを全削除する必要がある。
  const needsMigration = body.embedDim !== undefined && body.embedDim !== dbVectorDim;

  if (needsMigration && !body.applyMigration) {
    return Response.json(
      {
        error: "migration_required",
        message: t(locale, "settings.migrationRequired", { current: dbVectorDim, new: newDim }),
        currentDim: dbVectorDim,
        newDim,
      },
      { status: 409 },
    );
  }

  let pipelineResetForMigration = false;
  if (needsMigration && body.applyMigration) {
    // embedding 列は text（JSON）なので DDL 不要。次元が変わるため
    // 既存ベクトルデータを全削除（異なるモデル空間のベクトルは互換しない）。
    // memories と page_embeddings は会話から再生成可能なため削除。
    await db.delete(memories);
    await db.delete(pageEmbeddings);
    // skills はユーザー作成の永続プロンプトなので削除せず再 embed する。
    // embedText は新しい EMBED_MODEL/EMBED_DIM を参照するため、
    // resetEmbedPipeline() の後に呼ぶ必要があるが、ここではまだ env 更新前。
    // そのため process.env を先に更新してから再 embed する。
    for (const [k, v] of Object.entries({
      EMBED_MODEL: body.embedModel ?? process.env.EMBED_MODEL ?? "",
      EMBED_DIM: String(body.embedDim ?? process.env.EMBED_DIM ?? "1024"),
      EMBED_PROVIDER: body.embedProvider ?? process.env.EMBED_PROVIDER ?? "",
    })) {
      process.env[k] = v;
    }
    resetEmbedPipeline();
    pipelineResetForMigration = true;
    const allSkills = await db.select({ id: skills.id, content: skills.content }).from(skills);
    for (const skill of allSkills) {
      const vector = await embedText(skill.content, "document");
      await db.update(skills).set({ embedding: vector }).where(eq(skills.id, skill.id));
    }
  }

  // 既定のグローバルインストラクション選択を DB に保存
  if (body.activeInstructionId !== undefined) {
    await db
      .update(users)
      .set({ activeInstructionId: body.activeInstructionId || null })
      .where(eq(users.id, user.id));
  }

  // パーソナライズ設定を DB に保存（ユーザー単位）
  if (
    body.personalStyle !== undefined ||
    body.personalWarmth !== undefined ||
    body.personalEnergy !== undefined ||
    body.personalStructure !== undefined ||
    body.personalEmoji !== undefined
  ) {
    await db
      .update(users)
      .set({
        ...(body.personalStyle !== undefined ? { personalStyle: body.personalStyle } : {}),
        ...(clampedWarmth !== undefined ? { personalWarmth: clampedWarmth } : {}),
        ...(clampedEnergy !== undefined ? { personalEnergy: clampedEnergy } : {}),
        ...(clampedStructure !== undefined ? { personalStructure: clampedStructure } : {}),
        ...(clampedEmoji !== undefined ? { personalEmoji: clampedEmoji } : {}),
      })
      .where(eq(users.id, user.id));
  }

  // .env に全設定を保存
  try {
    const envPath = resolveEnvPath();
    let envContent = "";
    try {
      envContent = readFileSync(envPath, "utf8");
    } catch {
      envContent = "";
    }
    const updates: Record<string, string> = {};
    // LLM
    if (body.llmBaseUrl !== undefined) updates.LLM_BASE_URL = body.llmBaseUrl;
    if (body.llmApiKey !== undefined) updates.LLM_API_KEY = body.llmApiKey;
    if (body.llmModel !== undefined) updates.LLM_MODEL = body.llmModel;
    if (body.llmModels !== undefined) updates.LLM_MODELS = body.llmModels;
    if (body.thinkingEffort !== undefined) updates.THINKING_EFFORT = body.thinkingEffort;
    // Embeddings
    if (body.embedModel !== undefined) updates.EMBED_MODEL = body.embedModel;
    if (body.embedDim !== undefined) updates.EMBED_DIM = String(body.embedDim);
    if (body.embedProvider !== undefined) updates.EMBED_PROVIDER = body.embedProvider;
    if (body.webSearchMaxResults !== undefined) updates.WEB_SEARCH_MAX_RESULTS = String(body.webSearchMaxResults);
    if (body.webSearchMaxRounds !== undefined) updates.WEB_SEARCH_MAX_ROUNDS = String(body.webSearchMaxRounds);
    if (body.scraperUrl !== undefined) updates.SCRAPER_URL = body.scraperUrl;
    if (body.searxngUrl !== undefined) updates.SEARXNG_URL = body.searxngUrl;
    if (body.webSearchModel !== undefined) updates.WEB_SEARCH_MODEL = body.webSearchModel;
    // Tor プロキシ
    if (body.torProxy !== undefined) updates.TOR_PROXY = body.torProxy;
    if (body.scrapeProxy !== undefined) updates.SCRAPE_PROXY = body.scrapeProxy;
    // Database
    if (body.databaseUrl !== undefined) updates.DATABASE_URL = body.databaseUrl;
    // 実行環境
    if (body.hostOs !== undefined) updates.HOST_OS = body.hostOs;
    if (body.tz !== undefined) updates.TZ = body.tz;
    // Notion OAuth
    if (body.notionClientId !== undefined) updates.NOTION_CLIENT_ID = body.notionClientId;
    if (body.notionClientSecret !== undefined) updates.NOTION_CLIENT_SECRET = body.notionClientSecret;
    if (body.authUrl !== undefined) updates.AUTH_URL = body.authUrl;
    // Cloudflare Tunnel — トークンは空文字列の場合は更新しない（既存値を保持）
    if (body.tunnelToken !== undefined && body.tunnelToken !== "") updates.TUNNEL_TOKEN = body.tunnelToken;
    envContent = updateEnvContent(envContent, updates);

    writeFileSync(envPath, envContent);

    // process.env にも反映
    for (const [key, value] of Object.entries(updates)) {
      process.env[key] = value;
    }
    // LLM 関連設定が変更された場合はプロセス内キャッシュを無効化（再起動不要で反映）
    const llmChanged = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_MODELS"].some(
      (k) => k in updates,
    );
    if (llmChanged) {
      resetUmansModelsCache();
      resetToolProbeCache();
    }
    // Embedding 関連設定が変更された場合は transformers.js パイプラインキャッシュを無効化
    // （EMBED_MODEL 変更で異なるモデルをロードする必要があるため）
    const embedChanged = ["EMBED_MODEL", "EMBED_DIM", "EMBED_PROVIDER"].some(
      (k) => k in updates,
    );
    if (embedChanged && !pipelineResetForMigration) {
      resetEmbedPipeline();
    }
    // scraper の設定を動的更新（SCRAPE_PROXY / SCRAPE_TIMEOUT 変更時）
    // scraper コンテナは compose 起動時に環境変数が固定されるため、
    // /config エンドポイント経由でプロセス内変数を書き換えて即時反映する
    const scraperChanged = ["SCRAPE_PROXY", "SCRAPE_TIMEOUT"].some((k) => k in updates);
    if (scraperChanged) {
      const scraperBase = process.env.SCRAPER_URL || "http://localhost:8000";
      fetch(`${scraperBase}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scrape_proxy: process.env.SCRAPE_PROXY ?? "",
          scrape_timeout: Number(process.env.SCRAPE_TIMEOUT) || 30,
        }),
      }).catch(() => {
        // scraper が一時的にダウンしても .env / process.env は更新済み。
        // 次回起動時に compose が .env から読み込むため永続化は保証される
      });
    }
  } catch (err) {
    return Response.json(
      { error: t(locale, "settings.apiEnvUpdateFail", { error: err instanceof Error ? err.message : String(err) }) },
      { status: 500 },
    );
  }

  return Response.json({
    success: true,
    migrationApplied: needsMigration,
    message: needsMigration
      ? t(locale, "settings.migrationComplete")
      : t(locale, "settings.saved"),
  });
}
