// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetUmansModelsCache,
  getUmansModels,
  getModelDisplayNames,
  isUmansProvider,
} from "@/lib/llm";

// fetch をモック
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetUmansModelsCache();
});

const ORIGINAL_BASE_URL = process.env.LLM_BASE_URL;
afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = ORIGINAL_BASE_URL;
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

describe("isUmansProvider", () => {
  it("api.code.umans.ai を含む場合は true", () => {
    process.env.LLM_BASE_URL = "https://api.code.umans.ai/v1";
    expect(isUmansProvider()).toBe(true);
  });

  it("OpenAI URL の場合は false", () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    expect(isUmansProvider()).toBe(false);
  });

  it("未設定時は false", () => {
    delete process.env.LLM_BASE_URL;
    expect(isUmansProvider()).toBe(false);
  });
});

describe("getUmansModels", () => {
  beforeEach(() => {
    resetUmansModelsCache();
  });

  it("Umansモードで /v1/models/info からモデル情報を取得", async () => {
    process.env.LLM_BASE_URL = "https://api.code.umans.ai/v1";
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

  it("deprecated モデルの replacement をパース", async () => {
    process.env.LLM_BASE_URL = "https://api.code.umans.ai/v1";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_RESPONSE),
    });

    const models = await getUmansModels();
    const kimi = models.find((m) => m.id === "umans-kimi-k2.6");
    expect(kimi?.deprecated).toBe(true);
    expect(kimi?.replacement).toBe("umans-kimi-k2.7");
  });

  it("display_name が無い場合は id にフォールバック", async () => {
    process.env.LLM_BASE_URL = "https://api.code.umans.ai/v1";
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

  it("API 失敗時は MODEL_REASONING ハードコードにフォールバック", async () => {
    process.env.LLM_BASE_URL = "https://api.code.umans.ai/v1";
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const models = await getUmansModels();
    // 7モデル（MODEL_REASONING の全エントリ）
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

  it("HTTP エラー時もフォールバック", async () => {
    process.env.LLM_BASE_URL = "https://api.code.umans.ai/v1";
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

    const models = await getUmansModels();
    expect(models).toHaveLength(7);
  });

  it("Umansモードでない場合は空配列（fetch しない）", async () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    const models = await getUmansModels();
    expect(models).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("2回目の呼び出しはキャッシュを返し（fetch 1回のみ）", async () => {
    process.env.LLM_BASE_URL = "https://api.code.umans.ai/v1";
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

  it("Umansモード時は id → display_name マッピングを返す", async () => {
    process.env.LLM_BASE_URL = "https://api.code.umans.ai/v1";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_RESPONSE),
    });

    const names = await getModelDisplayNames();
    expect(names["umans-glm-5.2"]).toBe("Umans GLM 5.2");
    expect(names["umans-qwen3.6-35b-a3b"]).toBe("Umans Qwen3.6 35B A3B");
  });

  it("OAIモード時は空オブジェクト", async () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    const names = await getModelDisplayNames();
    expect(names).toEqual({});
  });
});
