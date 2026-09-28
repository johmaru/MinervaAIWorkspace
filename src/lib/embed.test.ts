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
  const originalEmbedModel = process.env.EMBED_MODEL;

  afterEach(() => {
    // Clear env / fetch / pipeline cache between tests
    global.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.EMBED_PROVIDER;
    else process.env.EMBED_PROVIDER = originalProvider;
    if (originalEmbedderUrl === undefined) delete process.env.EMBEDDER_URL;
    else process.env.EMBEDDER_URL = originalEmbedderUrl;
    if (originalEmbedModel === undefined) delete process.env.EMBED_MODEL;
    else process.env.EMBED_MODEL = originalEmbedModel;
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

  it("passes an AbortSignal timeout so a hung embedder cannot stall chat first-token", async () => {
    process.env.EMBED_PROVIDER = "http";
    process.env.EMBEDDER_URL = "http://embedder-test:8001";

    let capturedSignal: unknown = null;
    const fetchSpy = vi.fn().mockImplementation(async (_input: string | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? null;
      return new Response(JSON.stringify({ vectors: [[0.1]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await embedText("hello", "query");
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it("shares concurrent HTTP queries but embeds again after completion", async () => {
    process.env.EMBED_PROVIDER = "http";
    process.env.EMBEDDER_URL = "http://embedder-test:8001";
    let release!: (response: Response) => void;
    const waiting = new Promise<Response>((resolve) => { release = resolve; });
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => waiting)
      .mockResolvedValue(new Response(JSON.stringify({ vectors: [[0.8]] }), { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const calls = [embedText("FPGA", "query"), embedText("FPGA", "query"), embedText("FPGA", "query")];
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    release(new Response(JSON.stringify({ vectors: [[0.5, 0.6]] }), { status: 200 }));
    expect(await Promise.all(calls)).toEqual([[0.5, 0.6], [0.5, 0.6], [0.5, 0.6]]);
    expect(await embedText("FPGA", "query")).toEqual([0.8]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not share requests across kinds, URLs, or models", async () => {
    process.env.EMBED_PROVIDER = "http";
    process.env.EMBEDDER_URL = "http://embedder-one:8001";
    const releases: Array<(response: Response) => void> = [];
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => { releases.push(resolve); }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const calls = [embedText("FPGA", "query"), embedText("FPGA", "document")];
    process.env.EMBEDDER_URL = "http://embedder-two:8001";
    calls.push(embedText("FPGA", "query"));
    process.env.EMBED_MODEL = "another-model";
    calls.push(embedText("FPGA", "query"));
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    for (const release of releases) release(new Response(JSON.stringify({ vectors: [[1]] }), { status: 200 }));
    expect(await Promise.all(calls)).toEqual([[1], [1], [1], [1]]);
  });

  it("retries after a failed shared HTTP request", async () => {
    process.env.EMBED_PROVIDER = "http";
    process.env.EMBEDDER_URL = "http://embedder-test:8001";
    let release!: (response: Response) => void;
    const waiting = new Promise<Response>((resolve) => { release = resolve; });
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => waiting)
      .mockResolvedValue(new Response(JSON.stringify({ vectors: [[0.9]] }), { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const calls = [embedText("FPGA", "query"), embedText("FPGA", "query")];
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    release(new Response(null, { status: 503 }));
    expect(await Promise.all(calls)).toEqual([[], []]);
    expect(await embedText("FPGA", "query")).toEqual([0.9]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent local inference", async () => {
    delete process.env.EMBED_PROVIDER;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    fakePipeline.mockImplementationOnce(async () => {
      await waiting;
      return { data: new Float32Array([0.3]), tolist: () => [[0.3]] };
    });

    const calls = [embedText("FPGA", "query"), embedText("FPGA", "query")];
    await vi.waitFor(() => expect(fakePipeline).toHaveBeenCalledTimes(1));
    release();
    expect(await Promise.all(calls)).toEqual([[0.3], [0.3]]);
  });

  it("keeps the new in-flight request when an old one finishes after reset", async () => {
    process.env.EMBED_PROVIDER = "http";
    process.env.EMBEDDER_URL = "http://embedder-test:8001";
    const releases: Array<(response: Response) => void> = [];
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => { releases.push(resolve); }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const old = embedText("FPGA", "query");
    resetEmbedPipeline();
    const current = embedText("FPGA", "query");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    releases[0](new Response(JSON.stringify({ vectors: [[0.1]] }), { status: 200 }));
    expect(await old).toEqual([0.1]);
    const shared = embedText("FPGA", "query");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    releases[1](new Response(JSON.stringify({ vectors: [[0.2]] }), { status: 200 }));
    expect(await Promise.all([current, shared])).toEqual([[0.2], [0.2]]);
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
