import { db } from "@/db";
import { sql } from "drizzle-orm";
import { getRequestLocale, t } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/types";

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
 * 指定テーブルの vector 列の次元を取得。
 * 行が存在する場合は vector_dims() で、空の場合は列の宣言型（vector(N)）から取得。
 * どちらも取得できない場合は 0。
 *
 * table は "memories" | "page_embeddings" のみ（呼び出し元で固定）。
 * FROM ${tableName} は sql.raw で識別子を埋め込むため、引数を union 型にして
 * 型レベルで安全を保証する。
 */
async function getTableVectorDim(table: "memories" | "page_embeddings"): Promise<number> {
  const tableName = table === "page_embeddings" ? sql.raw("page_embeddings") : sql.raw("memories");
  try {
    // 行があれば vector_dims() で実次元
    const result = await db.execute(sql`SELECT vector_dims(embedding) as dim FROM ${tableName} LIMIT 1`);
    const rows = (result as { rows?: Array<{ dim: number }> }).rows;
    if (rows && rows.length > 0) return rows[0].dim;
    // 行が空でも列の宣言型 vector(N) から次元を取得。
    // ${table} は文字列リテラルとして bind され '::regclass' でキャストされるため安全。
    const colResult = await db.execute(sql`
      SELECT format_type(atttypid, atttypmod) as ty
      FROM pg_attribute
      WHERE attrelid = ${table}::regclass AND attname = 'embedding'
    `);
    const colRows = (colResult as { rows?: Array<{ ty: string }> }).rows;
    if (colRows && colRows.length > 0) {
      const m = colRows[0].ty.match(/vector\((\d+)\)/);
      if (m) return Number(m[1]);
    }
  } catch {
    // テーブル未作成 or エラー時は 0
  }
  return 0;
}

/**
 * memories / page_embeddings 両テーブルの vector 列次元を取得。
 * 検索クエリは両テーブルを横断するため、次元不整合を両方で検出する必要がある。
 */
async function getVectorDim(): Promise<{ memories: number; pageEmbeddings: number }> {
  const [memories, pageEmbeddings] = await Promise.all([
    getTableVectorDim("memories"),
    getTableVectorDim("page_embeddings"),
  ]);
  return { memories, pageEmbeddings };
}


/**
 * GET /api/settings — 現在の全設定 + 候補リストを返す。
 */
export async function GET(req: Request) {
  const locale = getRequestLocale(req);
  const dbVectorDim = (await getVectorDim()).memories;

  return Response.json({
    // LLM
    llmBaseUrl: process.env.LLM_BASE_URL || "",
    llmApiKey: process.env.LLM_API_KEY || "",
    llmModel: process.env.LLM_MODEL || "umans-glm-5.2",
    llmModels: process.env.LLM_MODELS || "",
    thinkingEffort: process.env.THINKING_EFFORT || "medium",
    // Embeddings
    embedModel: process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2",
    embedDim: Number(process.env.EMBED_DIM) || 384,
    embedProvider: process.env.EMBED_PROVIDER || "local",
    embedModelOptions: getEmbedModelOptions(locale),
    dbVectorDim,
    // Web 検索
    webSearchMaxResults: Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3,
    webSearchMaxRounds: Number(process.env.WEB_SEARCH_MAX_ROUNDS) || 2,
    scraperUrl: process.env.SCRAPER_URL || "http://localhost:8000",
    searxngUrl: process.env.SEARXNG_URL || "http://localhost:8080",
    // Tor プロキシ
    torProxy: process.env.TOR_PROXY || "",
    scrapeProxy: process.env.SCRAPE_PROXY || "",
    // Database
    databaseUrl: process.env.DATABASE_URL || "",
  });
}

type SettingsBody = {
  // LLM
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmModels?: string;
  thinkingEffort?: string;
  // Embeddings
  embedModel?: string;
  embedDim?: number;
  embedProvider?: string;
  // Web 検索
  webSearchMaxResults?: number;
  webSearchMaxRounds?: number;
  scraperUrl?: string;
  searxngUrl?: string;
  // Tor プロキシ
  torProxy?: string;
  scrapeProxy?: string;
  // Database
  databaseUrl?: string;
  // マイグレーション確認
  applyMigration?: boolean;
};

/**
 * POST /api/settings — 全設定を .env に保存。
 *
 * embedModel の次元が変わる場合は applyMigration=true で vector 列を再作成。
 */
export async function POST(req: Request) {
  const locale = getRequestLocale(req);
  let body: SettingsBody;
  try {
    body = (await req.json()) as SettingsBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // バリデーション
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
  const dims = await getVectorDim();
  const dbVectorDim = dims.memories;

  // 新しい次元を決定
  const newDim = body.embedDim ?? Number(process.env.EMBED_DIM) ?? 384;
  // 両テーブルの次元が newDim と一致しない、または互いに不一致なら要マイグレーション。
  // 検索クエリは memories と page_embeddings を横断するため、片方だけずれても
  // "different vector dimensions" エラーになる。
  const needsMigration =
    (dims.memories > 0 && dims.memories !== newDim) ||
    (dims.pageEmbeddings > 0 && dims.pageEmbeddings !== newDim) ||
    (dims.memories > 0 && dims.pageEmbeddings > 0 && dims.memories !== dims.pageEmbeddings);

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

  if (needsMigration && body.applyMigration) {
    // newDim は 1-4096 の整数としてバリデーション済み。DDL の型修飾子
    // vector(N) は bind parameter を許可しないため raw で埋め込む。
    const dim = sql.raw(String(newDim));
    // 1. インデックス削除（列削除前に依存を解除）
    await db.execute(sql`DROP INDEX IF EXISTS "memories_embedding_hnsw"`);
    await db.execute(sql`DROP INDEX IF EXISTS "page_embeddings_embedding_hnsw"`);
    // 2. 既存ベクトルデータを全削除（次元が変わるため変換不可）。
    //    先に削除することで、空テーブルに対する ADD COLUMN ... NOT NULL が成功する。
    await db.execute(sql`DELETE FROM memories`);
    await db.execute(sql`DELETE FROM page_embeddings`);
    // 3. 列を再作成（テーブルが空なので NOT NULL でも失敗しない）
    await db.execute(sql`ALTER TABLE "memories" DROP COLUMN "embedding"`);
    await db.execute(sql`ALTER TABLE "memories" ADD COLUMN "embedding" vector(${dim}) NOT NULL`);
    await db.execute(sql`ALTER TABLE "page_embeddings" DROP COLUMN "embedding"`);
    await db.execute(sql`ALTER TABLE "page_embeddings" ADD COLUMN "embedding" vector(${dim}) NOT NULL`);
    // 4. インデックス再作成
    await db.execute(sql`CREATE INDEX "memories_embedding_hnsw" ON "memories" USING hnsw ("embedding" vector_cosine_ops)`);
    await db.execute(sql`CREATE INDEX "page_embeddings_embedding_hnsw" ON "page_embeddings" USING hnsw ("embedding" vector_cosine_ops)`);
  }

  // .env に全設定を保存
  try {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const envPath = resolve(process.cwd(), ".env");
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
    // Tor プロキシ
    if (body.torProxy !== undefined) updates.TOR_PROXY = body.torProxy;
    if (body.scrapeProxy !== undefined) updates.SCRAPE_PROXY = body.scrapeProxy;
    // Database
    if (body.databaseUrl !== undefined) updates.DATABASE_URL = body.databaseUrl;

    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }

    writeFileSync(envPath, envContent);

    // process.env にも反映
    for (const [key, value] of Object.entries(updates)) {
      process.env[key] = value;
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
