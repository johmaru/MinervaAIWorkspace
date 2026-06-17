// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/llm";
import { createLLM, defaultModel, embedModel } from "@/lib/llm";

describe("llm client", () => {
  const ORIGINAL = {
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
    EMBED_MODEL: process.env.EMBED_MODEL,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
  });

  it("createLLM は LLM_BASE_URL 必須", () => {
    delete process.env.LLM_BASE_URL;
    expect(() => createLLM()).toThrow(/LLM_BASE_URL/);
  });

  it("createLLM は baseURL / apiKey を反映する", () => {
    process.env.LLM_BASE_URL = "https://example.test/v1";
    process.env.LLM_API_KEY = "sk-test";
    const client = createLLM();
    expect(client.baseURL).toBe("https://example.test/v1");
    expect(client.apiKey).toBe("sk-test");
  });

  it("apiKey 未設定時は 'missing' にフォールバック", () => {
    process.env.LLM_BASE_URL = "https://example.test/v1";
    delete process.env.LLM_API_KEY;
    expect(createLLM().apiKey).toBe("missing");
  });

  it("defaultModel は LLM_MODEL を優先、未設定なら gpt-4o-mini", () => {
    process.env.LLM_MODEL = "umans-glm-5.2";
    expect(defaultModel()).toBe("umans-glm-5.2");
    delete process.env.LLM_MODEL;
    expect(defaultModel()).toBe("gpt-4o-mini");
  });

  it("embedModel は EMBED_MODEL を優先、未設定なら text-embedding-3-small", () => {
    process.env.EMBED_MODEL = "custom-embed";
    expect(embedModel()).toBe("custom-embed");
    delete process.env.EMBED_MODEL;
    expect(embedModel()).toBe("text-embedding-3-small");
  });
});

describe("ChatMessage 型", () => {
  it("role は system | user | assistant のいずれか", () => {
    const m: ChatMessage = { role: "assistant", content: "hi" };
    expect(m.role).toBe("assistant");
    expect(m.content).toBe("hi");
  });
});