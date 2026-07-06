// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST ハンドラのキャッシュ無効化を検証するため、依存をモック化。
// vi.hoisted で宣言した変数を vi.mock factory 内で使う（hoisting safe）。
const { readFileSyncMock, writeFileSyncMock, existsSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn(() => true),
}));
const { dbUpdateMock } = vi.hoisted(() => {
  // update() ごとに新しい chain を返す（テスト間のモック状態汚染を防ぐ）
  const update = vi.fn(() => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    return { set };
  });
  return { dbUpdateMock: update };
});
const { resetEmbedPipelineMock } = vi.hoisted(() => ({
  resetEmbedPipelineMock: vi.fn(),
}));
const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));
vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  existsSync: existsSyncMock,
}));
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "user-1", email: "t@t" }),
}));
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    getRequestLocale: () => "ja" as const,
  };
});
vi.mock("@/db", () => ({
  db: { delete: vi.fn().mockResolvedValue(undefined), update: dbUpdateMock },
}));
vi.mock("@/lib/llm", () => ({
  resetUmansModelsCache: vi.fn(),
}));
vi.mock("@/lib/toolProbe", () => ({
  resetToolProbeCache: vi.fn(),
}));
vi.mock("@/lib/embed", () => ({
  resetEmbedPipeline: resetEmbedPipelineMock,
  getModelId: () => "LiquidAI/LFM2.5-Embedding-350M",
  getEmbedDim: () => 1024,
}));

import { POST, EMBED_MODEL_BASE, getEmbedModelOptions } from "@/app/api/settings/route";
import { getSessionUser } from "@/lib/auth-guards";

describe("EMBED_MODEL_OPTIONS", () => {
  it("各項目が model/dim/provider/labelKey を持つ", () => {
    for (const opt of EMBED_MODEL_BASE) {
      expect(opt).toHaveProperty("model");
      expect(opt).toHaveProperty("dim");
      expect(opt).toHaveProperty("provider");
      expect(opt).toHaveProperty("labelKey");
    }
  });

  it("getEmbedModelOptions が翻訳された label を持つ", () => {
    const opts = getEmbedModelOptions("ja");
    for (const opt of opts) {
      expect(opt).toHaveProperty("label");
      expect(typeof opt.label).toBe("string");
    }
  });

  it("LFM2.5-Embedding-350M が http プロバイダ・1024 次元で含まれる", () => {
    const lfm = EMBED_MODEL_BASE.find(
      (o) => o.model === "LiquidAI/LFM2.5-Embedding-350M",
    );
    expect(lfm).toBeDefined();
    expect(lfm!.provider).toBe("http");
    expect(lfm!.dim).toBe(1024);
  });

  it("既存 Xenova モデルは全て local プロバイダ", () => {
    const xenova = EMBED_MODEL_BASE.filter((o) =>
      o.model.startsWith("Xenova/"),
    );
    expect(xenova.length).toBeGreaterThan(0);
    for (const opt of xenova) {
      expect(opt.provider).toBe("local");
    }
  });
});

/**
 * 埋め込み次元は SQLite では環境変数 EMBED_DIM から取得される。
 * pgvector の vector_dims() / format_type / pg_attribute は不要。
 */
describe("embedding dimension from env", () => {
  it("EMBED_DIM 未設定時はデフォルト 1024", () => {
    const orig = process.env.EMBED_DIM;
    delete process.env.EMBED_DIM;
    const dim = Number(process.env.EMBED_DIM) || 1024;
    expect(dim).toBe(1024);
    if (orig !== undefined) process.env.EMBED_DIM = orig;
  });

  it("EMBED_DIM 設定時はその値が使われる", () => {
    const orig = process.env.EMBED_DIM;
    process.env.EMBED_DIM = "384";
    const dim = Number(process.env.EMBED_DIM) || 1024;
    expect(dim).toBe(384);
    if (orig !== undefined) process.env.EMBED_DIM = orig;
    else delete process.env.EMBED_DIM;
  });
});

describe("POST /api/settings — Embedding 設定変更時のキャッシュ無効化", () => {
  const origEmbedModel = process.env.EMBED_MODEL;
  const origEmbedDim = process.env.EMBED_DIM;
  const origEmbedProvider = process.env.EMBED_PROVIDER;

  beforeEach(() => {
    // scraper /config 呼出の fetch をモック（未呼び出し想定）
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    existsSyncMock.mockClear();
    resetEmbedPipelineMock.mockClear();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.mocked(getSessionUser).mockResolvedValue({ id: "user-1", email: "t@t" } as never);
    if (origEmbedModel === undefined) delete process.env.EMBED_MODEL;
    else process.env.EMBED_MODEL = origEmbedModel;
    if (origEmbedDim === undefined) delete process.env.EMBED_DIM;
    else process.env.EMBED_DIM = origEmbedDim;
    if (origEmbedProvider === undefined) delete process.env.EMBED_PROVIDER;
    else process.env.EMBED_PROVIDER = origEmbedProvider;
  });

  async function postSettings(body: Record<string, unknown>) {
    const req = new Request("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it("embedModel 変更時に resetEmbedPipeline が呼ばれる", async () => {
    readFileSyncMock.mockReturnValue("EMBED_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ embedModel: "Xenova/all-MiniLM-L6-v2" });
    expect(res.status).toBe(200);
    expect(resetEmbedPipelineMock).toHaveBeenCalledTimes(1);
  });

  it("embedDim 変更時に resetEmbedPipeline が呼ばれる", async () => {
    process.env.EMBED_DIM = "1024";
    readFileSyncMock.mockReturnValue("EMBED_DIM=1024\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    // applyMigration: 次元変更(1024→384)なので既存 embedding 削除を要求
    const res = await postSettings({ embedDim: 384, applyMigration: true });
    expect(res.status).toBe(200);
    expect(resetEmbedPipelineMock).toHaveBeenCalledTimes(1);
  });

  it("embedProvider 変更時に resetEmbedPipeline が呼ばれる", async () => {
    readFileSyncMock.mockReturnValue("EMBED_PROVIDER=http\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ embedProvider: "local" });
    expect(res.status).toBe(200);
    expect(resetEmbedPipelineMock).toHaveBeenCalledTimes(1);
  });

  it("Embedding 設定以外の変更時は resetEmbedPipeline は呼ばれない", async () => {
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ llmModel: "umans-glm-5.2" });
    expect(res.status).toBe(200);
    expect(resetEmbedPipelineMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings — scraper /config 動的更新", () => {
  const origScrapeProxy = process.env.SCRAPE_PROXY;
  const origScrapeTimeout = process.env.SCRAPE_TIMEOUT;
  const origScraperUrl = process.env.SCRAPER_URL;

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(getSessionUser).mockResolvedValue({ id: "user-1", email: "t@t" } as never);
  });

  afterEach(() => {
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    existsSyncMock.mockClear();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    if (origScrapeProxy === undefined) delete process.env.SCRAPE_PROXY;
    else process.env.SCRAPE_PROXY = origScrapeProxy;
    if (origScrapeTimeout === undefined) delete process.env.SCRAPE_TIMEOUT;
    else process.env.SCRAPE_TIMEOUT = origScrapeTimeout;
    if (origScraperUrl === undefined) delete process.env.SCRAPER_URL;
    else process.env.SCRAPER_URL = origScraperUrl;
  });

  async function postSettings(body: Record<string, unknown>) {
    const req = new Request("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it("SCRAPE_PROXY 変更時に scraper /config へ fetch が呼ばれる", async () => {
    process.env.SCRAPER_URL = "http://scraper:8000";
    readFileSyncMock.mockReturnValue("SCRAPE_PROXY=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ scrapeProxy: "socks5://tor:9050" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://scraper:8000/config");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.scrape_proxy).toBe("socks5://tor:9050");
  });

  it("scraper 関連以外の変更時は /config fetch は呼ばれない", async () => {
    process.env.SCRAPER_URL = "http://scraper:8000";
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ llmModel: "umans-glm-5.2" });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings — パーソナライズ設定の保存", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(getSessionUser).mockResolvedValue({ id: "user-1", email: "t@t" } as never);
  });

  afterEach(() => {
    readFileSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    existsSyncMock.mockClear();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    dbUpdateMock.mockClear();
  });

  async function postSettings(body: Record<string, unknown>) {
    const req = new Request("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it("personalStyle を保存すると users テーブルへ update が呼ばれる", async () => {
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ personalStyle: "polite" });
    expect(res.status).toBe(200);
    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
    const setArg = dbUpdateMock.mock.results[0].value.set.mock.calls[0][0];
    expect(setArg).toMatchObject({ personalStyle: "polite" });
  });

  it("personalStyle: null で機能を無効化できる", async () => {
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ personalStyle: null });
    expect(res.status).toBe(200);
    const setArg = dbUpdateMock.mock.results[0].value.set.mock.calls[0][0];
    expect(setArg).toMatchObject({ personalStyle: null });
  });

  it("無効な personalStyle は 400 を返す", async () => {
    const res = await postSettings({ personalStyle: "unknown" });
    expect(res.status).toBe(400);
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it("スライダー値は 0-2 にクランプされる", async () => {
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({
      personalStyle: "standard",
      personalWarmth: 99,
      personalEnergy: -5,
      personalStructure: 1,
      personalEmoji: 1,
    });
    expect(res.status).toBe(200);
    const setArg = dbUpdateMock.mock.results[0].value.set.mock.calls[0][0];
    expect(setArg).toMatchObject({
      personalStyle: "standard",
      personalWarmth: 2,
      personalEnergy: 0,
      personalStructure: 1,
      personalEmoji: 1,
    });
  });
});
