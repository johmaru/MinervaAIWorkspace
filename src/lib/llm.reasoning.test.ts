// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_REASONING,
  getReasoningLevels,
  getDefaultReasoningEffort,
  resetUmansModelsCache,
} from "@/lib/llm";

// These tests verify MODEL_REASONING via the fallback path.
// getUmansModels() attempts a network fetch; we mock fetch to reject so
// the hardcoded MODEL_REASONING values are used.

const fetchMock = vi.fn(() =>
  Promise.reject(new Error("test: force MODEL_REASONING fallback")),
);

const ORIGINAL = {
  LLM_PROVIDER: process.env.LLM_PROVIDER,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL,
};

beforeEach(() => {
  process.env.LLM_PROVIDER = "openai";
  delete process.env.LLM_BASE_URL;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  resetUmansModelsCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
  vi.unstubAllGlobals();
  resetUmansModelsCache();
});

describe("MODEL_REASONING", () => {
  it("all entries have levels (array) and defaultLevel (string|null)", () => {
    for (const [name, cfg] of Object.entries(MODEL_REASONING)) {
      expect(Array.isArray(cfg.levels)).toBe(true);
      expect(typeof cfg.defaultLevel === "string" || cfg.defaultLevel === null).toBe(true);
      void name;
    }
  });

  it("covers all 7 UmansAI API models", () => {
    const expected = [
      "umans-kimi-k2.6",
      "umans-kimi-k2.7",
      "umans-glm-5.1",
      "umans-glm-5.2",
      "umans-coder",
      "umans-flash",
      "umans-qwen3.6-35b-a3b",
    ];
    expect(Object.keys(MODEL_REASONING).sort()).toEqual([...expected].sort());
  });
});

describe("getReasoningLevels", () => {
  it("umans-glm-5.2 returns none/high/max", async () => {
    expect(await getReasoningLevels("umans-glm-5.2")).toEqual(["none", "high", "max"]);
  });

  it("umans-flash returns none/low/medium/high", async () => {
    expect(await getReasoningLevels("umans-flash")).toEqual(["none", "low", "medium", "high"]);
  });

  it("umans-glm-5.1 returns none/medium", async () => {
    expect(await getReasoningLevels("umans-glm-5.1")).toEqual(["none", "medium"]);
  });

  it("umans-coder (not controllable) returns empty array", async () => {
    expect(await getReasoningLevels("umans-coder")).toEqual([]);
  });

  it("umans-kimi-k2.6 (not controllable) returns empty array", async () => {
    expect(await getReasoningLevels("umans-kimi-k2.6")).toEqual([]);
  });

  it("unknown / freeform model returns DEFAULT_REASONING_LEVELS", async () => {
    expect(await getReasoningLevels("gpt-4o-mini")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("umans-qwen3.6-35b-a3b returns same levels as umans-flash (alias)", async () => {
    expect(await getReasoningLevels("umans-qwen3.6-35b-a3b")).toEqual(
      await getReasoningLevels("umans-flash"),
    );
  });
});

describe("getDefaultReasoningEffort", () => {
  it("umans-glm-5.2 default is high", async () => {
    expect(await getDefaultReasoningEffort("umans-glm-5.2")).toBe("high");
  });

  it("umans-flash default is medium", async () => {
    expect(await getDefaultReasoningEffort("umans-flash")).toBe("medium");
  });

  it("umans-glm-5.1 default is medium", async () => {
    expect(await getDefaultReasoningEffort("umans-glm-5.1")).toBe("medium");
  });

  it("umans-coder (not controllable) returns null", async () => {
    expect(await getDefaultReasoningEffort("umans-coder")).toBeNull();
  });

  it("umans-kimi-k2.7 (not controllable) returns null", async () => {
    expect(await getDefaultReasoningEffort("umans-kimi-k2.7")).toBeNull();
  });

  it("unknown / freeform model defaults to medium", async () => {
    expect(await getDefaultReasoningEffort("gpt-4o-mini")).toBe("medium");
  });
});

describe("getReasoningLevels — OpenAI-compatible catalog", () => {
  it("uses DEFAULT_REASONING_LEVELS for OpenAI /models entries without Umans metadata", async () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "gpt-4.1" }] }),
      }),
    );
    resetUmansModelsCache();
    expect(await getReasoningLevels("gpt-4.1")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(await getDefaultReasoningEffort("gpt-4.1")).toBe("medium");
  });
});
