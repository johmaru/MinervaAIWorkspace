// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// transformers.js のモデルロード（ネットワーク / ファイル I/O 依存）をモック。
// local プロバイダのテストがモデル未ダウンロード環境で失敗するのを防ぐ。
// vi.mock は hoist されるため、モック内で参照する変数は vi.hoisted で囲む。
const { fakePipeline } = vi.hoisted(() => ({
  fakePipeline: vi.fn(async (texts: string[]) => ({
    data: new Float32Array(texts.length * 3),
    tolist: () => [Array.from({ length: 3 }, () => 0.5)],
  })),
}));
vi.mock("@xenova/transformers", () => ({
  pipeline: () => fakePipeline,
  env: { backends: { onnx: { wasm: { wasmPaths: "" } } } },
}));
import { hashContent, embedText, resetEmbedPipeline } from "@/lib/embed";

describe("embed — hashContent", () => {
  it("同じ入力には同じハッシュを返す", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  it("異なる入力には異なるハッシュを返す", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });

  it("SHA-256 は 64 文字の hex", () => {
    const hash = hashContent("test");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("空文字でもハッシュを生成", () => {
    const hash = hashContent("");
    expect(hash).toHaveLength(64);
  });
});

describe("embed — プロバイダ切替", () => {
  const originalFetch = global.fetch;
  const originalProvider = process.env.EMBED_PROVIDER;
  const originalEmbedderUrl = process.env.EMBEDDER_URL;

  afterEach(() => {
    // テスト間の env / fetch / pipeline キャッシュをクリア
    global.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.EMBED_PROVIDER;
    else process.env.EMBED_PROVIDER = originalProvider;
    if (originalEmbedderUrl === undefined) delete process.env.EMBEDDER_URL;
    else process.env.EMBEDDER_URL = originalEmbedderUrl;
    fakePipeline.mockClear();
    resetEmbedPipeline();
    vi.restoreAllMocks();
  });

  it("EMBED_PROVIDER 未設定（local）時は transformers.js パスを選択し embedder に fetch しない", async () => {
    delete process.env.EMBED_PROVIDER;
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ vectors: [[0.1, 0.2]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    // local パスは transformers.js でローカル推論する。embedder への
    // fetch は発生しないことが重要（プロバイダ分岐の検証）。
    const vec = await embedText("hello", "query");
    expect(fetchSpy).not.toHaveBeenCalled();
    // local は kind を無視し、有効なベクトルを返す（次元はモデル依存）。
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBeGreaterThan(0);
  });

  it("EMBED_PROVIDER=http 時は EMBEDDER_URL/embed に kind を含めて POST する", async () => {
    process.env.EMBED_PROVIDER = "http";
    process.env.EMBEDDER_URL = "http://embedder-test:8001";

    let capturedBody: { texts?: string[]; kind?: string } | null = null;
    let capturedUrl = "";
    const fetchSpy = vi.fn().mockImplementation(async (input: string | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      if (init?.body) capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ vectors: [[0.5, 0.6, 0.7]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const vec = await embedText("hello", "query");
    expect(capturedUrl).toBe("http://embedder-test:8001/embed");
    expect(capturedBody).toEqual({ texts: ["hello"], kind: "query" });
    expect(vec).toEqual([0.5, 0.6, 0.7]);
  });

  it("embedder が 503 の時は空配列を返す", async () => {
    process.env.EMBED_PROVIDER = "http";
    process.env.EMBEDDER_URL = "http://embedder-test:8001";

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "model_loading" }), { status: 503 }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const vec = await embedText("hello", "query");
    expect(vec).toEqual([]);
  });

  it("EMBEDDER_URL 未設定で http プロバイダ時は空配列を返す", async () => {
    process.env.EMBED_PROVIDER = "http";
    delete process.env.EMBEDDER_URL;

    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const vec = await embedText("hello", "query");
    expect(vec).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("resetEmbedPipeline", () => {
  const originalEmbedModel = process.env.EMBED_MODEL;
  const originalEmbedDim = process.env.EMBED_DIM;

  afterEach(() => {
    if (originalEmbedModel === undefined) delete process.env.EMBED_MODEL;
    else process.env.EMBED_MODEL = originalEmbedModel;
    if (originalEmbedDim === undefined) delete process.env.EMBED_DIM;
    else process.env.EMBED_DIM = originalEmbedDim;
    resetEmbedPipeline();
  });

  it("EMBED_MODEL 変更後に新しいモデルでパイプラインを再ロードする", async () => {
    // local プロバイダを明示的に指定（http だとパイプラインを使わない）
    delete process.env.EMBED_PROVIDER;
    // 1回目のロードでパイプラインをキャッシュ
    process.env.EMBED_MODEL = "old-model";
    resetEmbedPipeline();
    await embedText("hello");
    expect(fakePipeline).toHaveBeenCalledTimes(1);

    // resetEmbedPipeline 後に再度 embedText を呼ぶとパイプラインが再ロードされる
    resetEmbedPipeline();
    await embedText("world");
    expect(fakePipeline).toHaveBeenCalledTimes(2);
  });

  it("パイプライン未ロード状態で呼んでも安全", () => {
    expect(() => resetEmbedPipeline()).not.toThrow();
  });
});
