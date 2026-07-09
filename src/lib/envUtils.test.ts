// @vitest-environment node
import { describe, expect, it } from "vitest";
import { escapeEnvValue, updateEnvContent } from "@/lib/envUtils";

describe("escapeEnvValue", () => {
  it("empty string becomes empty double quotes", () => {
    expect(escapeEnvValue("")).toBe('""');
  });

  it("normal values are also wrapped in double quotes", () => {
    expect(escapeEnvValue("sk-abc123")).toBe('"sk-abc123"');
  });

  it("escapes values containing double quotes", () => {
    expect(escapeEnvValue('say "hello"')).toBe('"say \\"hello\\""');
  });

  it("escapes values containing backslashes", () => {
    expect(escapeEnvValue("C:\\Users\\test")).toBe('"C:\\\\Users\\\\test"');
  });

  it("escapes newlines to \\n (injection prevention)", () => {
    const malicious = "foo\nMALICIOUS=bar";
    const escaped = escapeEnvValue(malicious);
    // The escaped result is a single line (newlines become \\n literals)
    expect(escaped).not.toContain("\n");
    expect(escaped).toBe('"foo\\nMALICIOUS=bar"');
  });

  it("escapes carriage returns to \\r", () => {
    const escaped = escapeEnvValue("foo\rbar");
    expect(escaped).not.toContain("\r");
    expect(escaped).toBe('"foo\\rbar"');
  });

  it("keeps # inside quotes (prevents dotenv comment interpretation)", () => {
    const escaped = escapeEnvValue("value#comment");
    expect(escaped).toBe('"value#comment"');
  });

  it("keeps = inside quotes", () => {
    const escaped = escapeEnvValue("a=b");
    expect(escaped).toBe('"a=b"');
  });
});

describe("updateEnvContent", () => {
  it("updates existing keys", () => {
    const env = "LLM_API_KEY=old\nLLM_MODEL=gpt-4o";
    const result = updateEnvContent(env, { LLM_API_KEY: "new" });
    expect(result).toContain('LLM_API_KEY="new"');
    expect(result).toContain("LLM_MODEL=gpt-4o");
  });

  it("appends new keys at the end", () => {
    const env = "LLM_API_KEY=old";
    const result = updateEnvContent(env, { TOR_PROXY: "socks5://tor:9050" });
    expect(result).toContain('TOR_PROXY="socks5://tor:9050"');
  });

  it("values with newlines do not create new environment variables", () => {
    const env = "LLM_API_KEY=old";
    const malicious = "foo\nMALICIOUS=bar";
    const result = updateEnvContent(env, { LLM_API_KEY: malicious });
    // Result is only 2 lines (original LLM_API_KEY line + 1 updated line)
    // MALICIOUS is not interpreted as a separate line
    const lines = result.split("\n");
    const maliciousLine = lines.find((l) => l.startsWith("MALICIOUS="));
    expect(maliciousLine).toBeUndefined();
  });
});
