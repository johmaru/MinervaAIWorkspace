// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/models/route";

// process.env を一時的に上書き
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("GET /api/models", () => {
  // OAI互換モード（isUmansProvider() === false）で検証するため、
  // 各テストで LLM_BASE_URL を UmansAPI 以外に固定。
  it("LLM_MODELS からモデルリストを構築", async () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODELS = "umans-glm-5.2,gpt-4o-mini,gpt-4o";
    process.env.LLM_MODEL = "umans-glm-5.2";
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      models: string[];
      default: string;
      displayNames: Record<string, string>;
    };
    expect(data.models).toEqual(["umans-glm-5.2", "gpt-4o-mini", "gpt-4o"]);
    expect(data.default).toBe("umans-glm-5.2");
    // OAIモード時は displayNames は空
    expect(data.displayNames).toEqual({});
  });

  it("LLM_MODELS 未設定時は defaultModel のみ", async () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    delete process.env.LLM_MODELS;
    process.env.LLM_MODEL = "gpt-4o-mini";
    const res = await GET();
    const data = (await res.json()) as { models: string[]; default: string };
    expect(data.models).toEqual(["gpt-4o-mini"]);
    expect(data.default).toBe("gpt-4o-mini");
  });

  it("空白のみの LLM_MODELS は defaultModel にフォールバック", async () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODELS = "  ,  ,  ";
    process.env.LLM_MODEL = "umans-glm-5.2";
    const res = await GET();
    const data = (await res.json()) as { models: string[]; default: string };
    expect(data.models).toEqual(["umans-glm-5.2"]);
  });

  it("LLM_MODEL も未設定時はハードコードのデフォルト", async () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    delete process.env.LLM_MODELS;
    delete process.env.LLM_MODEL;
    const res = await GET();
    const data = (await res.json()) as { models: string[]; default: string };
    expect(data.default).toBe("umans-glm-5.2");
  });
});
