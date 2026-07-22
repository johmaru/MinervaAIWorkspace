import { readFileSync, writeFileSync } from "node:fs";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { users, memories, pageEmbeddings, skills, todos } from "@/db/schema";
import { getRequestLocale, t } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/types";
import { resetUmansModelsCache } from "@/lib/llm";
import { resetToolProbeCache } from "@/lib/toolProbe";
import { getSessionUser } from "@/lib/auth-guards";
import { resetEmbedPipeline, embedText } from "@/lib/embed";
import { PERSONAL_STYLES } from "@/lib/personalization";
import { resolveEnvPath, updateEnvContent } from "@/lib/envUtils";
import { getConfiguredAuthUrl, setConfiguredAuthUrl } from "@/lib/auth-env";
import { getLogFilePath } from "@/lib/logger";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EmbedModelBase = {
  model: string;
  dim: number;
  provider: "local" | "http";
  labelKey: string;
};

/**
 * Embedding model candidates.
 * provider: "local" = transformers.js (ONNX) / "http" = Python embedder service
 * label is translated via t() according to locale.
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
 * Returns embedding model candidates for the given locale.
 * label is translated. Tests can inspect structure via EMBED_MODEL_BASE.
 */
export function getEmbedModelOptions(locale: Locale) {
  return EMBED_MODEL_BASE.map((o) => ({ ...o, label: t(locale, o.labelKey) }));
}

/** Test-only: structure without label */
export { EMBED_MODEL_BASE };

/**
 * Get the current embedding dimension.
 * In SQLite, embeddings are stored as JSON arrays (text columns), so the dimension
 * comes from the EMBED_DIM environment variable rather than the column type.
 * When the dimension changes, existing data must be cleared, but no column DDL
 * is needed (text columns can store JSON of any dimension).
 */
function getEmbedDim(): number {
  return Number(process.env.EMBED_DIM) || 1024;
}



/**
 * GET /api/settings — Returns all current settings + candidate lists.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const locale = getRequestLocale(req);

  // Get per-user settings (DB): default global instruction + personalization
  const [userRow] = await db
    .select({
      activeInstructionId: users.activeInstructionId,
      personalStyle: users.personalStyle,
      personalWarmth: users.personalWarmth,
      personalEnergy: users.personalEnergy,
      personalStructure: users.personalStructure,
      personalEmoji: users.personalEmoji,
      translatePrimaryLang: users.translatePrimaryLang,
    })
    .from(users)
    .where(eq(users.id, user.id));

  return Response.json({
    // LLM
    // Do not return secrets in plaintext; return only whether they are set.
    // SettingsModal sends llmApiKey only when the user enters a new value;
    // when omitted, it sends undefined to preserve the existing value.
    llmApiKey: "",
    hasLlmApiKey: !!process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL || "umans-glm-5.2",
    llmFallbackModel: process.env.LLM_FALLBACK_MODEL || "",
    llmFallbackTimeoutMs: Number(process.env.LLM_FALLBACK_TIMEOUT_MS) || 10000,
    thinkingEffort: process.env.THINKING_EFFORT || "medium",
    webSearchThinkingEffort: process.env.WEB_SEARCH_THINKING_EFFORT || "none",
    // Embeddings
    embedModel: process.env.EMBED_MODEL || "LiquidAI/LFM2.5-Embedding-350M",
    embedDim: Number(process.env.EMBED_DIM) || 1024,
    embedProvider: process.env.EMBED_PROVIDER || "http",
    embedModelOptions: getEmbedModelOptions(locale),
    dbVectorDim: getEmbedDim(),
    dbPageEmbeddingsDim: getEmbedDim(),
    // Web search
    webSearchModel: process.env.WEB_SEARCH_MODEL || "umans-qwen3.6-35b-a3b",
    webSearchMaxResults: Number(process.env.WEB_SEARCH_MAX_RESULTS) || 3,
    webSearchMaxRounds: Number(process.env.WEB_SEARCH_MAX_ROUNDS) || 3,
    scraperUrl: process.env.SCRAPER_URL || "http://localhost:8000",
    searxngUrl: process.env.SEARXNG_URL || "http://localhost:8080",
    // Tor proxy
    torProxy: process.env.TOR_PROXY || "",
    scrapeProxy: process.env.SCRAPE_PROXY || "",
    // Database / runtime environment — do not return connection string in
    // plaintext (may contain credentials); return only whether it is set.
    databaseUrl: "",
    hasDatabaseUrl: !!process.env.DATABASE_URL,
    hostOs: process.env.HOST_OS || "",
    tz: process.env.TZ || "",
    // Notion OAuth
    notionClientId: process.env.NOTION_CLIENT_ID || "",
    // Do not return secrets in plaintext; return only whether they are set.
    notionClientSecret: "",
    hasNotionClientSecret: !!process.env.NOTION_CLIENT_SECRET,
    // GitHub OAuth (Connections)
    githubConnectionsClientId: process.env.GITHUB_CONNECTIONS_CLIENT_ID || "",
    githubConnectionsClientSecret: "",
    hasGithubConnectionsClientSecret: !!process.env.GITHUB_CONNECTIONS_CLIENT_SECRET,
    // Google Connections OAuth (separate from login GOOGLE_CLIENT_*)
    googleConnectionsClientId: process.env.GOOGLE_CONNECTIONS_CLIENT_ID || "",
    googleConnectionsClientSecret: "",
    hasGoogleConnectionsClientSecret: !!process.env.GOOGLE_CONNECTIONS_CLIENT_SECRET,
    // Microsoft OAuth (Outlook mail + calendar)
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || "",
    microsoftClientSecret: "",
    hasMicrosoftClientSecret: !!process.env.MICROSOFT_CLIENT_SECRET,
    microsoftTenantId: process.env.MICROSOFT_TENANT_ID || "common",
    authUrl: getConfiguredAuthUrl(),
    // Cloudflare Tunnel — do not return token in plaintext; return only whether it is set
    tunnelToken: "",
    hasTunnelToken: !!process.env.TUNNEL_TOKEN,
    // Security — registration lock + IP whitelist
    registrationLocked: process.env.REGISTRATION_LOCKED === "true",
    allowedRegistrationIps: process.env.ALLOWED_REGISTRATION_IPS || "",
    // Default global instruction selection (per-user, DB)
    activeInstructionId: userRow?.activeInstructionId ?? null,
    // Personalization (per-user, DB)
    personalStyle: userRow?.personalStyle ?? null,
    personalWarmth: userRow?.personalWarmth ?? 1,
    personalEnergy: userRow?.personalEnergy ?? 1,
    personalStructure: userRow?.personalStructure ?? 1,
    translatePrimaryLang: userRow?.translatePrimaryLang ?? null,
    personalEmoji: userRow?.personalEmoji ?? 1,
    translateDefaultMulti: process.env.TRANSLATE_DEFAULT_MULTI === "true",
    translateTimeout: Number(process.env.TRANSLATE_TIMEOUT) || 30,
    // Logging
    logLevel: process.env.LOG_LEVEL || "info",
    logFileEnabled: process.env.LOG_FILE_ENABLED || "true",
    logFilePath: getLogFilePath(),
    // Chat export
    chatExportPath: process.env.CHAT_EXPORT_PATH || "",
  });
}

type SettingsBody = {
  // LLM
  llmApiKey?: string;
  // Default global instruction selection (per-user, saved to DB)
  activeInstructionId?: string | null;
  // Personalization (per-user, saved to DB)
  personalStyle?: string | null;
  personalWarmth?: number;
  personalEnergy?: number;
  translatePrimaryLang?: string | null;
  personalStructure?: number;
  personalEmoji?: number;
  llmModel?: string;
  llmFallbackModel?: string;
  llmFallbackTimeoutMs?: number;
  webSearchThinkingEffort?: string;
  thinkingEffort?: string;
  // Embeddings
  embedModel?: string;
  embedDim?: number;
  embedProvider?: string;
  // Web search
  webSearchModel?: string;
  webSearchMaxResults?: number;
  webSearchMaxRounds?: number;
  scraperUrl?: string;
  searxngUrl?: string;
  // Tor proxy
  torProxy?: string;
  scrapeProxy?: string;
  // Database
  databaseUrl?: string;
  // Runtime environment
  hostOs?: string;
  tz?: string;
  // Notion OAuth
  notionClientId?: string;
  notionClientSecret?: string;
  // GitHub OAuth (Connections)
  githubConnectionsClientId?: string;
  githubConnectionsClientSecret?: string;
  // Google Connections OAuth
  googleConnectionsClientId?: string;
  googleConnectionsClientSecret?: string;
  // Microsoft OAuth
  microsoftClientId?: string;
  microsoftClientSecret?: string;
  microsoftTenantId?: string;
  authUrl?: string;
  // Cloudflare Tunnel
  tunnelToken?: string;
  // Security
  registrationLocked?: boolean;
  allowedRegistrationIps?: string;
  // Translate default mode
  translateDefaultMulti?: boolean;
  translateTimeout?: number;
  // Logging
  logLevel?: string;
  logFileEnabled?: string;
  // Chat export
  chatExportPath?: string;
  applyMigration?: boolean;
};

/**
 * POST /api/settings — Save all settings to .env.
 *
 * If the embedModel dimension changes, pass applyMigration=true to recreate the vector column.
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

  // Validation
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
  if (body.webSearchThinkingEffort !== undefined && !/^[a-z0-9]+$/i.test(body.webSearchThinkingEffort)) {
    return new Response("webSearchThinkingEffort must be alphanumeric (e.g. none, low, medium, high, max)", { status: 400 });
  }
  if (body.translateTimeout !== undefined && (body.translateTimeout < 5 || body.translateTimeout > 300)) {
    return new Response("translateTimeout must be 5-300 (seconds)", { status: 400 });
  }

  // Personalization validation
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

  // Determine the new dimension
  const newDim = body.embedDim ?? dbVectorDim;
  // Embeddings are stored as Float32 BLOB (sqlite-vec). No DDL is needed for dimension changes
  // (BLOB storage class persists in TEXT-affinity columns without ALTER TABLE).
  // However, different models' vector spaces are incompatible, so when the dimension changes,
  // all existing embedding data must be deleted.
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
    // Embeddings are stored as Float32 BLOB. No DDL is needed. Since the dimension changes,
    // delete all existing vector data (vectors from different model spaces are incompatible).
    // memories and page_embeddings can be regenerated from conversations, so they are deleted.
    // skills are user-created persistent prompts, so they are not deleted but re-embedded.
    // embedText references the new EMBED_MODEL/EMBED_DIM, so it must be called after
    // resetEmbedPipeline(), but here the env is not yet updated.
    // Therefore, update process.env first, then re-embed.
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
    const allTodos = await db.select({ id: todos.id, title: todos.title, description: todos.description }).from(todos);
    for (const todo of allTodos) {
      const embedContent = `${todo.title}${todo.description ? "\n" + todo.description : ""}`;
      const vector = await embedText(embedContent, "document");
      await db.update(todos).set({ embedding: vector }).where(eq(todos.id, todo.id));
    }
  }

  // Save the default global instruction selection to the DB
  if (body.activeInstructionId !== undefined) {
    await db
      .update(users)
      .set({ activeInstructionId: body.activeInstructionId || null })
      .where(eq(users.id, user.id));
  }

  // Save personalization settings to the DB (per-user)
  if (
    body.personalStyle !== undefined ||
    body.personalWarmth !== undefined ||
    body.personalEnergy !== undefined ||
    body.personalStructure !== undefined ||
    body.personalEmoji !== undefined ||
    body.translatePrimaryLang !== undefined
  ) {
    await db
      .update(users)
      .set({
        ...(body.personalStyle !== undefined ? { personalStyle: body.personalStyle } : {}),
        ...(clampedWarmth !== undefined ? { personalWarmth: clampedWarmth } : {}),
        ...(clampedEnergy !== undefined ? { personalEnergy: clampedEnergy } : {}),
        ...(clampedStructure !== undefined ? { personalStructure: clampedStructure } : {}),
        ...(clampedEmoji !== undefined ? { personalEmoji: clampedEmoji } : {}),
        ...(body.translatePrimaryLang !== undefined ? { translatePrimaryLang: body.translatePrimaryLang || null } : {}),
      })
      .where(eq(users.id, user.id));
  }

  // Save all settings to .env
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
    if (body.llmApiKey !== undefined) updates.LLM_API_KEY = body.llmApiKey;
    if (body.llmModel !== undefined) updates.LLM_MODEL = body.llmModel;
    if (body.llmFallbackModel !== undefined) updates.LLM_FALLBACK_MODEL = body.llmFallbackModel;
    if (body.llmFallbackTimeoutMs !== undefined) updates.LLM_FALLBACK_TIMEOUT_MS = String(body.llmFallbackTimeoutMs);
    if (body.thinkingEffort !== undefined) updates.THINKING_EFFORT = body.thinkingEffort;
    if (body.webSearchThinkingEffort !== undefined) updates.WEB_SEARCH_THINKING_EFFORT = body.webSearchThinkingEffort;
    // Embeddings
    if (body.embedModel !== undefined) updates.EMBED_MODEL = body.embedModel;
    if (body.embedDim !== undefined) updates.EMBED_DIM = String(body.embedDim);
    if (body.embedProvider !== undefined) updates.EMBED_PROVIDER = body.embedProvider;
    if (body.webSearchMaxResults !== undefined) updates.WEB_SEARCH_MAX_RESULTS = String(body.webSearchMaxResults);
    if (body.webSearchMaxRounds !== undefined) updates.WEB_SEARCH_MAX_ROUNDS = String(body.webSearchMaxRounds);
    // URL fields: validate scheme to prevent SSRF
    if (body.scraperUrl !== undefined) {
      try { const u = new URL(body.scraperUrl); if (!["http:", "https:"].includes(u.protocol)) throw new Error(); updates.SCRAPER_URL = body.scraperUrl; }
      catch { return new Response("Invalid scraperUrl: must be http(s) URL", { status: 400 }); }
    }
    if (body.searxngUrl !== undefined) {
      try { const u = new URL(body.searxngUrl); if (!["http:", "https:"].includes(u.protocol)) throw new Error(); updates.SEARXNG_URL = body.searxngUrl; }
      catch { return new Response("Invalid searxngUrl: must be http(s) URL", { status: 400 }); }
    }
    if (body.webSearchModel !== undefined) updates.WEB_SEARCH_MODEL = body.webSearchModel;
    // Proxy fields: validate scheme
    if (body.torProxy !== undefined && body.torProxy !== "") {
      if (!/^(socks5|http|https):\/\//.test(body.torProxy)) return new Response("Invalid torProxy: must be socks5/http(s) URL", { status: 400 });
      updates.TOR_PROXY = body.torProxy;
    }
    if (body.torProxy === "") updates.TOR_PROXY = "";
    if (body.scrapeProxy !== undefined && body.scrapeProxy !== "") {
      if (!/^(socks5|http|https):\/\//.test(body.scrapeProxy)) return new Response("Invalid scrapeProxy: must be socks5/http(s) URL", { status: 400 });
      updates.SCRAPE_PROXY = body.scrapeProxy;
    }
    if (body.scrapeProxy === "") updates.SCRAPE_PROXY = "";
    // Database URL: reject remote DB protocols (prevent DB hijacking)
    if (body.databaseUrl !== undefined) {
      if (/^(https?:|postgres:|postgresql:|mysql:|mongodb:|redis:|mssql:)/i.test(body.databaseUrl)) {
        return new Response("Invalid databaseUrl: remote database protocols not allowed", { status: 400 });
      }
      updates.DATABASE_URL = body.databaseUrl;
    }
    // Runtime environment
    if (body.hostOs !== undefined) updates.HOST_OS = body.hostOs;
    if (body.tz !== undefined) updates.TZ = body.tz;
    // Notion OAuth
    if (body.notionClientId !== undefined) updates.NOTION_CLIENT_ID = body.notionClientId;
    if (body.notionClientSecret !== undefined) updates.NOTION_CLIENT_SECRET = body.notionClientSecret;
    // GitHub OAuth (Connections)
    if (body.githubConnectionsClientId !== undefined) updates.GITHUB_CONNECTIONS_CLIENT_ID = body.githubConnectionsClientId;
    if (body.githubConnectionsClientSecret !== undefined) updates.GITHUB_CONNECTIONS_CLIENT_SECRET = body.githubConnectionsClientSecret;
    // Google Connections OAuth
    if (body.googleConnectionsClientId !== undefined) updates.GOOGLE_CONNECTIONS_CLIENT_ID = body.googleConnectionsClientId;
    if (body.googleConnectionsClientSecret !== undefined) updates.GOOGLE_CONNECTIONS_CLIENT_SECRET = body.googleConnectionsClientSecret;
    // Microsoft OAuth
    if (body.microsoftClientId !== undefined) updates.MICROSOFT_CLIENT_ID = body.microsoftClientId;
    if (body.microsoftClientSecret !== undefined) updates.MICROSOFT_CLIENT_SECRET = body.microsoftClientSecret;
    if (body.microsoftTenantId !== undefined) updates.MICROSOFT_TENANT_ID = body.microsoftTenantId;
    if (body.authUrl !== undefined) {
      try { const u = new URL(body.authUrl); if (!["http:", "https:"].includes(u.protocol)) throw new Error(); updates.AUTH_URL = body.authUrl; }
      catch { return new Response("Invalid authUrl: must be http(s) URL", { status: 400 }); }
    }
    // Cloudflare Tunnel — do not update token when empty string (preserve existing value)
    if (body.tunnelToken !== undefined && body.tunnelToken !== "") updates.TUNNEL_TOKEN = body.tunnelToken;
    // Security
    if (body.registrationLocked !== undefined) updates.REGISTRATION_LOCKED = body.registrationLocked ? "true" : "false";
    if (body.allowedRegistrationIps !== undefined) updates.ALLOWED_REGISTRATION_IPS = body.allowedRegistrationIps;
    if (body.translateDefaultMulti !== undefined) updates.TRANSLATE_DEFAULT_MULTI = body.translateDefaultMulti ? "true" : "false";
    if (body.translateTimeout !== undefined) updates.TRANSLATE_TIMEOUT = String(body.translateTimeout);
    // Logging
    if (body.logLevel !== undefined) updates.LOG_LEVEL = body.logLevel;
    if (body.logFileEnabled !== undefined) updates.LOG_FILE_ENABLED = body.logFileEnabled;
    // Chat export path: prevent path traversal
    if (body.chatExportPath !== undefined) {
      if (body.chatExportPath.includes("..")) return new Response("Invalid chatExportPath: path traversal not allowed", { status: 400 });
      updates.CHAT_EXPORT_PATH = body.chatExportPath;
    }
    envContent = updateEnvContent(envContent, updates);

    writeFileSync(envPath, envContent);

    // Also reflect in process.env
    for (const [key, value] of Object.entries(updates)) {
      process.env[key] = value;
    }
    // AUTH_URL is written to .env for persistence, but Auth.js must NOT read a
    // sticky process.env.AUTH_URL (dual local + Cloudflare access). Mirror it
    // to UMANS_CONFIGURED_AUTH_URL and delete AUTH_URL from process.env.
    if (body.authUrl !== undefined) {
      setConfiguredAuthUrl(body.authUrl);
    }
    // Invalidate in-process cache when LLM-related settings change (no restart needed)
    const llmChanged = ["LLM_API_KEY", "LLM_MODEL", "LLM_FALLBACK_MODEL", "LLM_FALLBACK_TIMEOUT_MS"].some(
      (k) => k in updates,
    );
    if (llmChanged) {
      resetUmansModelsCache();
      resetToolProbeCache();
    }
    // Invalidate transformers.js pipeline cache when embedding-related settings change
    // (EMBED_MODEL change requires loading a different model)
    const embedChanged = ["EMBED_MODEL", "EMBED_DIM", "EMBED_PROVIDER"].some(
      (k) => k in updates,
    );
    if (embedChanged && !pipelineResetForMigration) {
      resetEmbedPipeline();
    }
    // Dynamically update scraper settings (when SCRAPE_PROXY / SCRAPE_TIMEOUT change)
    // The scraper container's environment variables are fixed at compose startup,
    // so in-process variables are rewritten via the /config endpoint for immediate effect
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
        // Even if scraper is temporarily down, .env / process.env are already updated.
        // Persistence is guaranteed since compose reads from .env on next startup.
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
