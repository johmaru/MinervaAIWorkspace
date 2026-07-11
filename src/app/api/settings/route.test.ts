// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// To verify cache invalidation of the POST handler, dependencies are mocked.
// Variables declared via vi.hoisted are used inside vi.mock factories (hoisting-safe).
const { readFileSyncMock, writeFileSyncMock, existsSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn(() => true),
}));
const { dbUpdateMock } = vi.hoisted(() => {
  // Return a new chain for each update() call (prevents mock state pollution between tests)
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
  db: {
    delete: vi.fn().mockResolvedValue(undefined),
    update: dbUpdateMock,
    select: vi.fn(() => {
      const from = vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
        // select().from(table) without .where() — used by skills re-embed
        then: (resolve: unknown) => Promise.resolve([]).then(resolve as never),
      }));
      // select().from(table) returns a thenable when no .where() is chained
      const chain = {
        from,
        where: vi.fn().mockResolvedValue([]),
        then: (resolve: unknown) => Promise.resolve([]).then(resolve as never),
      };
      return chain;
    }),
  },
}));
vi.mock("@/lib/llm", () => ({
  resetUmansModelsCache: vi.fn(),
}));
vi.mock("@/lib/toolProbe", () => ({
  resetToolProbeCache: vi.fn(),
}));
vi.mock("@/lib/embed", () => ({
  resetEmbedPipeline: resetEmbedPipelineMock,
  embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  getModelId: () => "LiquidAI/LFM2.5-Embedding-350M",
  getEmbedDim: () => 1024,
}));

import { POST, GET, EMBED_MODEL_BASE, getEmbedModelOptions } from "@/app/api/settings/route";
import { getSessionUser } from "@/lib/auth-guards";

describe("EMBED_MODEL_OPTIONS", () => {
  it("each item has model/dim/provider/labelKey", () => {
    for (const opt of EMBED_MODEL_BASE) {
      expect(opt).toHaveProperty("model");
      expect(opt).toHaveProperty("dim");
      expect(opt).toHaveProperty("provider");
      expect(opt).toHaveProperty("labelKey");
    }
  });

  it("getEmbedModelOptions returns translated label", () => {
    const opts = getEmbedModelOptions("ja");
    for (const opt of opts) {
      expect(opt).toHaveProperty("label");
      expect(typeof opt.label).toBe("string");
    }
  });

  it("LFM2.5-Embedding-350M is included with http provider and 1024 dimensions", () => {
    const lfm = EMBED_MODEL_BASE.find(
      (o) => o.model === "LiquidAI/LFM2.5-Embedding-350M",
    );
    expect(lfm).toBeDefined();
    expect(lfm!.provider).toBe("http");
    expect(lfm!.dim).toBe(1024);
  });

  it("existing Xenova models are all local provider", () => {
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
 * Embedding dimension is obtained from the EMBED_DIM environment variable in SQLite.
 * pgvector's vector_dims() / format_type / pg_attribute are not needed.
 */
describe("embedding dimension from env", () => {
  it("defaults to 1024 when EMBED_DIM is not set", () => {
    const orig = process.env.EMBED_DIM;
    delete process.env.EMBED_DIM;
    const dim = Number(process.env.EMBED_DIM) || 1024;
    expect(dim).toBe(1024);
    if (orig !== undefined) process.env.EMBED_DIM = orig;
  });

  it("uses the set value when EMBED_DIM is set", () => {
    const orig = process.env.EMBED_DIM;
    process.env.EMBED_DIM = "384";
    const dim = Number(process.env.EMBED_DIM) || 1024;
    expect(dim).toBe(384);
    if (orig !== undefined) process.env.EMBED_DIM = orig;
    else delete process.env.EMBED_DIM;
  });
});

describe("GET /api/settings — secret masking", () => {
  const origApiKey = process.env.LLM_API_KEY;
  const origNotionSecret = process.env.NOTION_CLIENT_SECRET;

  afterEach(() => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: "user-1", email: "t@t" } as never);
    if (origApiKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = origApiKey;
    if (origNotionSecret === undefined) delete process.env.NOTION_CLIENT_SECRET;
    else process.env.NOTION_CLIENT_SECRET = origNotionSecret;
  });

  it("does not return plaintext even when LLM_API_KEY is set; returns hasLlmApiKey=true", async () => {
    process.env.LLM_API_KEY = "sk-super-secret-key";
    const req = new Request("http://localhost/api/settings", { method: "GET" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json() as { llmApiKey: string; hasLlmApiKey: boolean };
    expect(data.llmApiKey).toBe("");
    expect(data.hasLlmApiKey).toBe(true);
  });

  it("returns hasLlmApiKey=false when LLM_API_KEY is not set", async () => {
    delete process.env.LLM_API_KEY;
    const req = new Request("http://localhost/api/settings", { method: "GET" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json() as { llmApiKey: string; hasLlmApiKey: boolean };
    expect(data.llmApiKey).toBe("");
    expect(data.hasLlmApiKey).toBe(false);
  });

  it("does not return plaintext even when NOTION_CLIENT_SECRET is set; returns hasNotionClientSecret=true", async () => {
    process.env.NOTION_CLIENT_SECRET = "secret_abc123";
    const req = new Request("http://localhost/api/settings", { method: "GET" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json() as { notionClientSecret: string; hasNotionClientSecret: boolean };
    expect(data.notionClientSecret).toBe("");
    expect(data.hasNotionClientSecret).toBe(true);
  });
});

describe("POST /api/settings — cache invalidation on embedding config change", () => {
  const origEmbedModel = process.env.EMBED_MODEL;
  const origEmbedDim = process.env.EMBED_DIM;
  const origEmbedProvider = process.env.EMBED_PROVIDER;

  beforeEach(() => {
    // Mock fetch for scraper /config call (expected to be uncalled)
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

  it("calls resetEmbedPipeline when embedModel changes", async () => {
    readFileSyncMock.mockReturnValue("EMBED_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ embedModel: "Xenova/all-MiniLM-L6-v2" });
    expect(res.status).toBe(200);
    expect(resetEmbedPipelineMock).toHaveBeenCalledTimes(1);
  });

  it("calls resetEmbedPipeline when embedDim changes", async () => {
    process.env.EMBED_DIM = "1024";
    readFileSyncMock.mockReturnValue("EMBED_DIM=1024\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    // applyMigration: dimension change (1024→384) requires deleting existing embeddings
    const res = await postSettings({ embedDim: 384, applyMigration: true });
    expect(res.status).toBe(200);
    expect(resetEmbedPipelineMock).toHaveBeenCalledTimes(1);
  });

  it("calls resetEmbedPipeline when embedProvider changes", async () => {
    readFileSyncMock.mockReturnValue("EMBED_PROVIDER=http\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ embedProvider: "local" });
    expect(res.status).toBe(200);
    expect(resetEmbedPipelineMock).toHaveBeenCalledTimes(1);
  });

  it("does not call resetEmbedPipeline when non-embedding settings change", async () => {
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ llmModel: "umans-glm-5.2" });
    expect(res.status).toBe(200);
    expect(resetEmbedPipelineMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings — scraper /config dynamic update", () => {
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

  it("calls fetch to scraper /config when SCRAPE_PROXY changes", async () => {
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

  it("does not call /config fetch when non-scraper settings change", async () => {
    process.env.SCRAPER_URL = "http://scraper:8000";
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ llmModel: "umans-glm-5.2" });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings — personalization settings save", () => {
  const origTranslateTimeout = process.env.TRANSLATE_TIMEOUT;

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
    if (origTranslateTimeout === undefined) delete process.env.TRANSLATE_TIMEOUT;
    else process.env.TRANSLATE_TIMEOUT = origTranslateTimeout;
  });

  async function postSettings(body: Record<string, unknown>) {
    const req = new Request("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it("saving personalStyle calls update on the users table", async () => {
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ personalStyle: "polite" });
    expect(res.status).toBe(200);
    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
    const setArg = dbUpdateMock.mock.results[0].value.set.mock.calls[0][0];
    expect(setArg).toMatchObject({ personalStyle: "polite" });
  });

  it("personalStyle: null disables the feature", async () => {
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ personalStyle: null });
    expect(res.status).toBe(200);
    const setArg = dbUpdateMock.mock.results[0].value.set.mock.calls[0][0];
    expect(setArg).toMatchObject({ personalStyle: null });
  });

  it("invalid personalStyle returns 400", async () => {
    const res = await postSettings({ personalStyle: "unknown" });
    expect(res.status).toBe(400);
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it("slider values are clamped to 0-2", async () => {
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

  it("translateTimeout: 4 returns 400", async () => {
    const res = await postSettings({ translateTimeout: 4 });
    expect(res.status).toBe(400);
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it("translateTimeout: 301 returns 400", async () => {
    const res = await postSettings({ translateTimeout: 301 });
    expect(res.status).toBe(400);
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it("translateTimeout: 60 writes TRANSLATE_TIMEOUT to .env", async () => {
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ translateTimeout: 60 });
    expect(res.status).toBe(200);
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('TRANSLATE_TIMEOUT="60"');
    expect(process.env.TRANSLATE_TIMEOUT).toBe("60");
  });
});

describe("POST /api/settings — partial security / GSI updates", () => {
  const origRegLocked = process.env.REGISTRATION_LOCKED;
  const origAllowedIps = process.env.ALLOWED_REGISTRATION_IPS;

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
    if (origRegLocked === undefined) delete process.env.REGISTRATION_LOCKED;
    else process.env.REGISTRATION_LOCKED = origRegLocked;
    if (origAllowedIps === undefined) delete process.env.ALLOWED_REGISTRATION_IPS;
    else process.env.ALLOWED_REGISTRATION_IPS = origAllowedIps;
  });

  async function postSettings(body: Record<string, unknown>) {
    const req = new Request("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it("writes REGISTRATION_LOCKED=\"true\" to .env and mirrors process.env", async () => {
    delete process.env.REGISTRATION_LOCKED;
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ registrationLocked: true });
    expect(res.status).toBe(200);
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('REGISTRATION_LOCKED="true"');
    expect(process.env.REGISTRATION_LOCKED).toBe("true");
  });

  it("writes REGISTRATION_LOCKED=\"false\" when registrationLocked is false", async () => {
    process.env.REGISTRATION_LOCKED = "true";
    readFileSyncMock.mockReturnValue('REGISTRATION_LOCKED="true"\n');
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ registrationLocked: false });
    expect(res.status).toBe(200);
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('REGISTRATION_LOCKED="false"');
    expect(process.env.REGISTRATION_LOCKED).toBe("false");
  });

  it("writes allowedRegistrationIps to .env and mirrors process.env", async () => {
    delete process.env.ALLOWED_REGISTRATION_IPS;
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ allowedRegistrationIps: "10.0.0.0/8" });
    expect(res.status).toBe(200);
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('ALLOWED_REGISTRATION_IPS="10.0.0.0/8"');
    expect(process.env.ALLOWED_REGISTRATION_IPS).toBe("10.0.0.0/8");
  });

  it("saves activeInstructionId to DB via users.update", async () => {
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ activeInstructionId: "instr-1" });
    expect(res.status).toBe(200);
    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
    const setArg = dbUpdateMock.mock.results[0].value.set.mock.calls[0][0];
    expect(setArg).toMatchObject({ activeInstructionId: "instr-1" });
  });

  it("saves activeInstructionId: null when value is null", async () => {
    readFileSyncMock.mockReturnValue("LLM_MODEL=old\n");
    writeFileSyncMock.mockImplementation(() => undefined);

    const res = await postSettings({ activeInstructionId: null });
    expect(res.status).toBe(200);
    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
    const setArg = dbUpdateMock.mock.results[0].value.set.mock.calls[0][0];
    expect(setArg).toMatchObject({ activeInstructionId: null });
  });
});
