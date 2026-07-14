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

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  resetUmansModelsCache();
});

afterEach(() => {
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

  it("unknown model returns empty array", async () => {
    expect(await getReasoningLevels("gpt-4o-mini")).toEqual([]);
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

  it("unknown model returns null", async () => {
    expect(await getDefaultReasoningEffort("gpt-4o-mini")).toBeNull();
  });
});
