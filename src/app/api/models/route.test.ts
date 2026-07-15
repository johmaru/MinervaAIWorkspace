// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));

// Mock fetch so getUmansModels doesn't hit the network.
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

import { GET } from "@/app/api/models/route";
import { resetUmansModelsCache } from "@/lib/llm";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetUmansModelsCache();
});

const SAMPLE_API_RESPONSE = {
  "umans-glm-5.2": {
    name: "umans-glm-5.2",
    display_name: "Umans GLM 5.2",
    capabilities: { reasoning: { levels: ["none", "high", "max"], default_level: "high" } },
    deprecation: null,
  },
  "umans-coder": {
    name: "umans-coder",
    display_name: "Umans Coder",
    capabilities: { reasoning: { levels: [], default_level: null } },
    deprecation: null,
  },
};

describe("GET /api/models", () => {
  beforeEach(() => {
    resetUmansModelsCache();
  });

  it("returns model list and displayNames from API", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_RESPONSE),
    });
    process.env.LLM_MODEL = "umans-glm-5.2";
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      models: string[];
      default: string;
      displayNames: Record<string, string>;
    };
    expect(data.models).toEqual(["umans-glm-5.2", "umans-coder"]);
    expect(data.default).toBe("umans-glm-5.2");
    expect(data.displayNames["umans-glm-5.2"]).toBe("Umans GLM 5.2");
    expect(data.displayNames["umans-coder"]).toBe("Umans Coder");
  });

  it("uses hardcoded default when LLM_MODEL is unset", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(SAMPLE_API_RESPONSE),
    });
    delete process.env.LLM_MODEL;
    const res = await GET();
    const data = (await res.json()) as { models: string[]; default: string };
    expect(data.default).toBe("umans-glm-5.2");
  });

  it("falls back to MODEL_REASONING on API failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    process.env.LLM_MODEL = "umans-glm-5.2";
    const res = await GET();
    const data = (await res.json()) as { models: string[]; default: string };
    expect(data.default).toBe("umans-glm-5.2");
    // Fallback returns all 7 MODEL_REASONING entries
    expect(data.models).toHaveLength(7);
    expect(data.models).toContain("umans-glm-5.2");
  });
});
