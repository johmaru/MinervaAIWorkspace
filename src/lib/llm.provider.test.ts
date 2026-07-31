// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLLM,
  defaultModel,
  llmBaseUrl,
  llmProvider,
  isUmansBaseUrl,
  UMANS_BASE_URL,
  resetUmansModelsCache,
} from "@/lib/llm";

describe("llm provider / baseURL", () => {
  const ORIGINAL = {
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
    resetUmansModelsCache();
    vi.restoreAllMocks();
  });

  it("llmProvider defaults to openai", () => {
    delete process.env.LLM_PROVIDER;
    expect(llmProvider()).toBe("openai");
  });

  it("llmProvider recognizes cursor", () => {
    process.env.LLM_PROVIDER = "cursor";
    expect(llmProvider()).toBe("cursor");
  });

  it("llmBaseUrl defaults to UmansAI", () => {
    delete process.env.LLM_BASE_URL;
    expect(llmBaseUrl()).toBe(UMANS_BASE_URL);
  });

  it("llmBaseUrl uses LLM_BASE_URL when set", () => {
    process.env.LLM_BASE_URL = "https://api.openai.com/v1";
    expect(llmBaseUrl()).toBe("https://api.openai.com/v1");
  });

  it("createLLM uses configurable baseURL", () => {
    process.env.LLM_API_KEY = "sk-test";
    process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
    const client = createLLM();
    expect(client.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("isUmansBaseUrl detects default Umans endpoint", () => {
    expect(isUmansBaseUrl(UMANS_BASE_URL)).toBe(true);
    expect(isUmansBaseUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("defaultModel uses composer-2.5 when provider is cursor", () => {
    process.env.LLM_PROVIDER = "cursor";
    delete process.env.LLM_MODEL;
    expect(defaultModel()).toBe("composer-2.5");
  });
});
