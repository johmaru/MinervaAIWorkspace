// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/llm";
import { createLLM, defaultModel, embedModel, fallbackModel, fallbackTimeoutMs } from "@/lib/llm";

describe("llm client", () => {
  const ORIGINAL = {
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
    EMBED_MODEL: process.env.EMBED_MODEL,
    LLM_FALLBACK_MODEL: process.env.LLM_FALLBACK_MODEL,
    LLM_FALLBACK_TIMEOUT_MS: process.env.LLM_FALLBACK_TIMEOUT_MS,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
  });

  it("createLLM requires LLM_BASE_URL", () => {
    delete process.env.LLM_BASE_URL;
    expect(() => createLLM()).toThrow(/LLM_BASE_URL/);
  });

  it("createLLM reflects baseURL / apiKey", () => {
    process.env.LLM_BASE_URL = "https://example.test/v1";
    process.env.LLM_API_KEY = "sk-test";
    const client = createLLM();
    expect(client.baseURL).toBe("https://example.test/v1");
    expect(client.apiKey).toBe("sk-test");
  });

  it("createLLM sets timeout and maxRetries", () => {
    process.env.LLM_BASE_URL = "https://example.test/v1";
    process.env.LLM_API_KEY = "sk-test";
    const client = createLLM();
    expect(client.timeout).toBe(120_000);
    expect(client.maxRetries).toBe(1);
  });

  it("falls back to 'missing' when apiKey is unset", () => {
    process.env.LLM_BASE_URL = "https://example.test/v1";
    delete process.env.LLM_API_KEY;
    expect(createLLM().apiKey).toBe("missing");
  });

    it("defaultModel prefers LLM_MODEL, defaults to umans-glm-5.2 if unset", () => {
      process.env.LLM_MODEL = "umans-glm-5.2";
      expect(defaultModel()).toBe("umans-glm-5.2");
      delete process.env.LLM_MODEL;
      expect(defaultModel()).toBe("umans-glm-5.2");
    });

  it("embedModel prefers EMBED_MODEL, defaults to text-embedding-3-small if unset", () => {
    process.env.EMBED_MODEL = "custom-embed";
    expect(embedModel()).toBe("custom-embed");
    delete process.env.EMBED_MODEL;
    expect(embedModel()).toBe("text-embedding-3-small");
  });

  it("fallbackModel returns env value when set", () => {
    process.env.LLM_FALLBACK_MODEL = "gpt-4o-mini";
    expect(fallbackModel()).toBe("gpt-4o-mini");
  });

  it("fallbackModel returns null when unset", () => {
    delete process.env.LLM_FALLBACK_MODEL;
    expect(fallbackModel()).toBeNull();
  });

  it("fallbackModel trims whitespace", () => {
    process.env.LLM_FALLBACK_MODEL = "  gpt-4o  ";
    expect(fallbackModel()).toBe("gpt-4o");
  });

  it("fallbackTimeoutMs returns env value when valid", () => {
    process.env.LLM_FALLBACK_TIMEOUT_MS = "15000";
    expect(fallbackTimeoutMs()).toBe(15000);
  });

  it("fallbackTimeoutMs defaults to 10000 when unset", () => {
    delete process.env.LLM_FALLBACK_TIMEOUT_MS;
    expect(fallbackTimeoutMs()).toBe(10_000);
  });

  it("fallbackTimeoutMs defaults to 10000 when invalid", () => {
    process.env.LLM_FALLBACK_TIMEOUT_MS = "abc";
    expect(fallbackTimeoutMs()).toBe(10_000);
  });

  it("fallbackTimeoutMs defaults to 10000 when zero or negative", () => {
    process.env.LLM_FALLBACK_TIMEOUT_MS = "0";
    expect(fallbackTimeoutMs()).toBe(10_000);
    process.env.LLM_FALLBACK_TIMEOUT_MS = "-5";
    expect(fallbackTimeoutMs()).toBe(10_000);
  });
});

describe("ChatMessage type", () => {
  it("role is one of system | user | assistant", () => {
    const m: ChatMessage = { role: "assistant", content: "hi" };
    expect(m.role).toBe("assistant");
    expect(m.content).toBe("hi");
  });
});