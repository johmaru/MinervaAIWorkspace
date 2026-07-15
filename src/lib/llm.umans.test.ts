// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetUmansModelsCache,
  getUmansModels,
  getModelDisplayNames,
} from "@/lib/llm";

// Mock fetch
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetUmansModelsCache();
});

const SAMPLE_API_RESPONSE = {
  "umans-glm-5.2": {
    name: "umans-glm-5.2",
    display_name: "Umans GLM 5.2",
    capabilities: { reasoning: { levels: ["none", "high", "max"], default_level: "high" } },
    deprecation: null,
  },
  "umans-qwen3.6-35b-a3b": {
    name: "umans-qwen3.6-35b-a3b",
    display_name: "Umans Qwen3.6 35B A3B",
    capabilities: { reasoning: { levels: ["none", "low", "medium", "high"], default_level: "medium" } },
    deprecation: null,
  },
  "umans-kimi-k2.6": {
    name: "umans-kimi-k2.6",
    display_name: "Umans Kimi K2.6",
    capabilities: { reasoning: { levels: [], default_level: null } },
    deprecation: { sunset_date: "2026-06-18", replacement: "umans-kimi-k2.7" },
  },
};

describe("getUmansModels", () => {
  beforeEach(() => {
    resetUmansModelsCache();
  });

  it("fetches model info from /v1/models/info", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_RESPONSE),
    });

    const models = await getUmansModels();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.code.umans.ai/v1/models/info",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(models).toHaveLength(3);
    const glm = models.find((m) => m.id === "umans-glm-5.2");
    expect(glm?.displayName).toBe("Umans GLM 5.2");
    expect(glm?.reasoning.levels).toEqual(["none", "high", "max"]);
    expect(glm?.reasoning.defaultLevel).toBe("high");
    expect(glm?.deprecated).toBe(false);
  });

  it("parses replacement for deprecated models", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_RESPONSE),
    });

    const models = await getUmansModels();
    const kimi = models.find((m) => m.id === "umans-kimi-k2.6");
    expect(kimi?.deprecated).toBe(true);
    expect(kimi?.replacement).toBe("umans-kimi-k2.7");
  });

  it("falls back to id when display_name is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          "umans-coder": {
            name: "umans-coder",
            capabilities: { reasoning: { levels: [], default_level: null } },
          },
        }),
    });

    const models = await getUmansModels();
    expect(models[0].displayName).toBe("umans-coder");
  });

  it("falls back to MODEL_REASONING hardcoded values on API failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const models = await getUmansModels();
    // 7 models (all entries in MODEL_REASONING)
    expect(models).toHaveLength(7);
    expect(models.map((m) => m.id).sort()).toEqual(
      [
        "umans-coder",
        "umans-flash",
        "umans-glm-5.1",
        "umans-glm-5.2",
        "umans-kimi-k2.6",
        "umans-kimi-k2.7",
        "umans-qwen3.6-35b-a3b",
      ].sort(),
    );
  });

  it("also falls back on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

    const models = await getUmansModels();
    expect(models).toHaveLength(7);
  });

  it("second call returns cache (fetch only once)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_RESPONSE),
    });

    await getUmansModels();
    await getUmansModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getModelDisplayNames", () => {
  beforeEach(() => {
    resetUmansModelsCache();
  });

  it("returns id → display_name mapping", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_RESPONSE),
    });

    const names = await getModelDisplayNames();
    expect(names["umans-glm-5.2"]).toBe("Umans GLM 5.2");
    expect(names["umans-qwen3.6-35b-a3b"]).toBe("Umans Qwen3.6 35B A3B");
  });
});
