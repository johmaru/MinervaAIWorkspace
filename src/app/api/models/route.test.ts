// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
import { GET } from "@/app/api/models/route";

// Temporarily override process.env
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("GET /api/models", () => {
  // To test in OAI-compatible mode (isUmansProvider() === false),
  // LLM_BASE_URL is fixed to a non-UmansAPI value in each test.
  it("builds model list from LLM_MODELS", async () => {
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
    // In OAI mode, displayNames is empty
    expect(data.displayNames).toEqual({});
  });

  it("returns only defaultModel when LLM_MODELS is unset", async () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    delete process.env.LLM_MODELS;
    process.env.LLM_MODEL = "gpt-4o-mini";
    const res = await GET();
    const data = (await res.json()) as { models: string[]; default: string };
    expect(data.models).toEqual(["gpt-4o-mini"]);
    expect(data.default).toBe("gpt-4o-mini");
  });

  it("falls back to defaultModel when LLM_MODELS is whitespace-only", async () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_MODELS = "  ,  ,  ";
    process.env.LLM_MODEL = "umans-glm-5.2";
    const res = await GET();
    const data = (await res.json()) as { models: string[]; default: string };
    expect(data.models).toEqual(["umans-glm-5.2"]);
  });

  it("uses hardcoded default when LLM_MODEL is also unset", async () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    delete process.env.LLM_MODELS;
    delete process.env.LLM_MODEL;
    const res = await GET();
    const data = (await res.json()) as { models: string[]; default: string };
    expect(data.default).toBe("umans-glm-5.2");
  });
});
