// @vitest-environment node
import { describe, expect, it } from "vitest";
import { escapeEnvValue, updateEnvContent } from "@/lib/envUtils";

describe("escapeEnvValue", () => {
  it("空文字は空のダブルクォートになる", () => {
    expect(escapeEnvValue("")).toBe('""');
  });

  it("通常の値もダブルクォートで囲む", () => {
    expect(escapeEnvValue("sk-abc123")).toBe('"sk-abc123"');
  });

  it("ダブルクォートを含む値をエスケープする", () => {
    expect(escapeEnvValue('say "hello"')).toBe('"say \\"hello\\""');
  });

  it("バックスラッシュを含む値をエスケープする", () => {
    expect(escapeEnvValue("C:\\Users\\test")).toBe('"C:\\\\Users\\\\test"');
  });

  it("改行を含む値を \\n にエスケープする（インジェクション防止）", () => {
    const malicious = "foo\nMALICIOUS=bar";
    const escaped = escapeEnvValue(malicious);
    // エスケープ結果は1行（改行が \n リテラルになる）
    expect(escaped).not.toContain("\n");
    expect(escaped).toBe('"foo\\nMALICIOUS=bar"');
  });

  it("キャリッジリターンを \\r にエスケープする", () => {
    const escaped = escapeEnvValue("foo\rbar");
    expect(escaped).not.toContain("\r");
    expect(escaped).toBe('"foo\\rbar"');
  });

  it("# を含む値をクォート内に入れる（dotenv コメント化防止）", () => {
    const escaped = escapeEnvValue("value#comment");
    expect(escaped).toBe('"value#comment"');
  });

  it("= を含む値をクォート内に入れる", () => {
    const escaped = escapeEnvValue("a=b");
    expect(escaped).toBe('"a=b"');
  });
});

describe("updateEnvContent", () => {
  it("既存キーを更新する", () => {
    const env = "LLM_API_KEY=old\nLLM_MODEL=gpt-4o";
    const result = updateEnvContent(env, { LLM_API_KEY: "new" });
    expect(result).toContain('LLM_API_KEY="new"');
    expect(result).toContain("LLM_MODEL=gpt-4o");
  });

  it("新規キーを末尾に追加する", () => {
    const env = "LLM_API_KEY=old";
    const result = updateEnvContent(env, { TOR_PROXY: "socks5://tor:9050" });
    expect(result).toContain('TOR_PROXY="socks5://tor:9050"');
  });

  it("改行を含む値を注入しても新しい環境変数が作られない", () => {
    const env = "LLM_API_KEY=old";
    const malicious = "foo\nMALICIOUS=bar";
    const result = updateEnvContent(env, { LLM_API_KEY: malicious });
    // 結果は2行のみ（元の LLM_API_KEY 行 + 更新された1行）
    // MALICIOUS が独立行として解釈されない
    const lines = result.split("\n");
    const maliciousLine = lines.find((l) => l.startsWith("MALICIOUS="));
    expect(maliciousLine).toBeUndefined();
  });
});
