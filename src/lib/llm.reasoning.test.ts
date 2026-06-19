// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MODEL_REASONING,
  getReasoningLevels,
  getDefaultReasoningEffort,
} from "@/lib/llm";

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
  it("umans-glm-5.2 は none/high/max を返す", () => {
    expect(getReasoningLevels("umans-glm-5.2")).toEqual(["none", "high", "max"]);
  });

  it("umans-flash は none/low/medium/high を返す", () => {
    expect(getReasoningLevels("umans-flash")).toEqual(["none", "low", "medium", "high"]);
  });

  it("umans-glm-5.1 は none/medium を返す", () => {
    expect(getReasoningLevels("umans-glm-5.1")).toEqual(["none", "medium"]);
  });

  it("umans-coder（制御不可）は空配列を返す", () => {
    expect(getReasoningLevels("umans-coder")).toEqual([]);
  });

  it("umans-kimi-k2.6（制御不可）は空配列を返す", () => {
    expect(getReasoningLevels("umans-kimi-k2.6")).toEqual([]);
  });

  it("未知モデルは空配列を返す", () => {
    expect(getReasoningLevels("gpt-4o-mini")).toEqual([]);
  });

  it("umans-qwen3.6-35b-a3b は umans-flash と同じ levels を返す（エイリアス）", () => {
    expect(getReasoningLevels("umans-qwen3.6-35b-a3b")).toEqual(
      getReasoningLevels("umans-flash"),
    );
  });
});

describe("getDefaultReasoningEffort", () => {
  it("umans-glm-5.2 のデフォルトは high", () => {
    expect(getDefaultReasoningEffort("umans-glm-5.2")).toBe("high");
  });

  it("umans-flash のデフォルトは medium", () => {
    expect(getDefaultReasoningEffort("umans-flash")).toBe("medium");
  });

  it("umans-glm-5.1 のデフォルトは medium", () => {
    expect(getDefaultReasoningEffort("umans-glm-5.1")).toBe("medium");
  });

  it("umans-coder（制御不可）は null を返す", () => {
    expect(getDefaultReasoningEffort("umans-coder")).toBeNull();
  });

  it("umans-kimi-k2.7（制御不可）は null を返す", () => {
    expect(getDefaultReasoningEffort("umans-kimi-k2.7")).toBeNull();
  });

  it("未知モデルは null を返す", () => {
    expect(getDefaultReasoningEffort("gpt-4o-mini")).toBeNull();
  });
});
