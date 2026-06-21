// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MODEL_REASONING,
  getReasoningLevels,
  getDefaultReasoningEffort,
} from "@/lib/llm";

// OAIモード（MODEL_REASONING を直接参照）で検証するため、
// LLM_BASE_URL を UmansAPI 以外に固定。これにより isUmansProvider() が false になり、
// ハードコード MODEL_REASONING の値が使われる。
const ORIGINAL_BASE_URL = process.env.LLM_BASE_URL;

beforeEach(() => {
  delete process.env.LLM_BASE_URL;
});

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = ORIGINAL_BASE_URL;
});

describe("MODEL_REASONING", () => {
  it("全エントリが levels(配列) と defaultLevel(string|null) を持つ", () => {
    for (const [name, cfg] of Object.entries(MODEL_REASONING)) {
      expect(Array.isArray(cfg.levels)).toBe(true);
      expect(typeof cfg.defaultLevel === "string" || cfg.defaultLevel === null).toBe(true);
      // void name to satisfy no-unused
      void name;
    }
  });

  it("UmansAI API の7モデルを網羅", () => {
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
  it("umans-glm-5.2 は none/high/max を返す", async () => {
    expect(await getReasoningLevels("umans-glm-5.2")).toEqual(["none", "high", "max"]);
  });

  it("umans-flash は none/low/medium/high を返す", async () => {
    expect(await getReasoningLevels("umans-flash")).toEqual(["none", "low", "medium", "high"]);
  });

  it("umans-glm-5.1 は none/medium を返す", async () => {
    expect(await getReasoningLevels("umans-glm-5.1")).toEqual(["none", "medium"]);
  });

  it("umans-coder（制御不可）は空配列を返す", async () => {
    expect(await getReasoningLevels("umans-coder")).toEqual([]);
  });

  it("umans-kimi-k2.6（制御不可）は空配列を返す", async () => {
    expect(await getReasoningLevels("umans-kimi-k2.6")).toEqual([]);
  });

  it("未知モデルは空配列を返す", async () => {
    expect(await getReasoningLevels("gpt-4o-mini")).toEqual([]);
  });

  it("umans-qwen3.6-35b-a3b は umans-flash と同じ levels を返す（エイリアス）", async () => {
    expect(await getReasoningLevels("umans-qwen3.6-35b-a3b")).toEqual(
      await getReasoningLevels("umans-flash"),
    );
  });
});

describe("getDefaultReasoningEffort", () => {
  it("umans-glm-5.2 のデフォルトは high", async () => {
    expect(await getDefaultReasoningEffort("umans-glm-5.2")).toBe("high");
  });

  it("umans-flash のデフォルトは medium", async () => {
    expect(await getDefaultReasoningEffort("umans-flash")).toBe("medium");
  });

  it("umans-glm-5.1 のデフォルトは medium", async () => {
    expect(await getDefaultReasoningEffort("umans-glm-5.1")).toBe("medium");
  });

  it("umans-coder（制御不可）は null を返す", async () => {
    expect(await getDefaultReasoningEffort("umans-coder")).toBeNull();
  });

  it("umans-kimi-k2.7（制御不可）は null を返す", async () => {
    expect(await getDefaultReasoningEffort("umans-kimi-k2.7")).toBeNull();
  });

  it("未知モデルは null を返す", async () => {
    expect(await getDefaultReasoningEffort("gpt-4o-mini")).toBeNull();
  });
});
