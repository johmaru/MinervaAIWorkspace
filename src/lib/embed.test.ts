// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock transformers.js model loading (depends on network / file I/O).
// Prevents local provider tests from failing when the model is not downloaded.
// vi.mock is hoisted, so variables referenced in the mock must be wrapped in vi.hoisted.
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
  it("same input returns the same hash", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  it("different input returns a different hash", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });

  it("SHA-256 is a 64-character hex string", () => {
    const hash = hashContent("test");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("generates a hash even for empty string", () => {
    const hash = hashContent("");
    expect(hash).toHaveLength(64);
  });
});

describe("embed — provider switching", () => {
  const originalFetch = global.fetch;
  const originalProvider = process.env.EMBED_PROVIDER;
  const originalEmbedderUrl = process.env.EMBEDDER_URL;

  afterEach(() => {
    // Clear env / fetch / pipeline cache between tests
    global.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.EMBED_PROVIDER;
    else process.env.EMBED_PROVIDER = originalProvider;
    if (originalEmbedderUrl === undefined) delete process.env.EMBEDDER_URL;
    else process.env.EMBEDDER_URL = originalEmbedderUrl;
    fakePipeline.mockClear();
    resetEmbedPipeline();
    vi.restoreAllMocks();
  });

  it("when EMBED_PROVIDER is unset (local), selects the transformers.js path and does not fetch the embedder", async () => {
    delete process.env.EMBED_PROVIDER;
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ vectors: [[0.1, 0.2]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    // The local path runs local inference via transformers.js. It is important that
    // no fetch to the embedder occurs (verifying provider branching).
    const vec = await embedText("hello", "query");
    expect(fetchSpy).not.toHaveBeenCalled();
    // local ignores kind and returns a valid vector (dimensions depend on the model).
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBeGreaterThan(0);
  });

  it("when EMBED_PROVIDER=http, POSTs to EMBEDDER_URL/embed with kind included", async () => {
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

  it("returns empty array when embedder returns 503", async () => {
    process.env.EMBED_PROVIDER = "http";
    process.env.EMBEDDER_URL = "http://embedder-test:8001";

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "model_loading" }), { status: 503 }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const vec = await embedText("hello", "query");
    expect(vec).toEqual([]);
  });

  it("returns empty array when http provider is set but EMBEDDER_URL is unset", async () => {
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

  it("reloads pipeline with the new model after EMBED_MODEL change", async () => {
    // Explicitly use local provider (http would not use the pipeline)
    delete process.env.EMBED_PROVIDER;
    // First load caches the pipeline
    process.env.EMBED_MODEL = "old-model";
    resetEmbedPipeline();
    await embedText("hello");
    expect(fakePipeline).toHaveBeenCalledTimes(1);

    // Calling embedText again after resetEmbedPipeline reloads the pipeline
    resetEmbedPipeline();
    await embedText("world");
    expect(fakePipeline).toHaveBeenCalledTimes(2);
  });

  it("safe to call when pipeline is not loaded", () => {
    expect(() => resetEmbedPipeline()).not.toThrow();
  });
});
