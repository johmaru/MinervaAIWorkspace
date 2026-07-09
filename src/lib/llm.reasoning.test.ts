// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MODEL_REASONING,
  getReasoningLevels,
  getDefaultReasoningEffort,
} from "@/lib/llm";

// To verify in OAI mode (directly referencing MODEL_REASONING),
// fix LLM_BASE_URL to a non-UmansAPI URL. This makes isUmansProvider() return false,
// so the hardcoded MODEL_REASONING values are used.
const ORIGINAL_BASE_URL = process.env.LLM_BASE_URL;

beforeEach(() => {
  delete process.env.LLM_BASE_URL;
});

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = ORIGINAL_BASE_URL;
});

describe("MODEL_REASONING", () => {
  it("all entries have levels (array) and defaultLevel (string|null)", () => {
    for (const [name, cfg] of Object.entries(MODEL_REASONING)) {
      expect(Array.isArray(cfg.levels)).toBe(true);
      expect(typeof cfg.defaultLevel === "string" || cfg.defaultLevel === null).toBe(true);
      // void name to satisfy no-unused
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
