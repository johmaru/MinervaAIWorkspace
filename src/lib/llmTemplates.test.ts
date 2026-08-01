import { describe, expect, it } from "vitest";
import { LLM_PLATFORM_TEMPLATES } from "@/lib/llmTemplates";

describe("LLM_PLATFORM_TEMPLATES", () => {
  it("has unique ids (stable identifiers for the UI select)", () => {
    const ids = LLM_PLATFORM_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique baseUrls (UI matching depends on exact baseUrl match)", () => {
    const urls = LLM_PLATFORM_TEMPLATES.map((t) => t.baseUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
