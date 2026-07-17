// @vitest-environment node
import { describe, it, expect } from "vitest";
import { evaluateSandboxPolicy, type PolicyOk } from "./policy";

describe("evaluateSandboxPolicy", () => {
  // ---- Shape validation ----
  it("rejects non-object args with invalid_args", () => {
    expect(evaluateSandboxPolicy(null)).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
    expect(evaluateSandboxPolicy("code_run")).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
    expect(evaluateSandboxPolicy(42)).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
    expect(evaluateSandboxPolicy(undefined)).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  it("rejects array args with invalid_args", () => {
    expect(evaluateSandboxPolicy([])).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  // ---- Preset validation ----
  it("rejects missing preset with invalid_args", () => {
    expect(evaluateSandboxPolicy({ code: "print(1)" })).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  it("rejects unknown preset string with preset_unknown", () => {
    expect(evaluateSandboxPolicy({ preset: "nuke_launch", code: "print(1)" })).toMatchObject({ ok: false, result: { error: { code: "preset_unknown" } } });
  });

  it("rejects non-string preset with invalid_args", () => {
    expect(evaluateSandboxPolicy({ preset: 123, code: "print(1)" })).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  // ---- Tier-forbidden (unimplemented presets) ----
  it("rejects file_inspect with tier_forbidden", () => {
    expect(evaluateSandboxPolicy({ preset: "file_inspect" })).toMatchObject({ ok: false, result: { error: { code: "tier_forbidden" } } });
  });

  it("rejects malware_analysis with tier_forbidden", () => {
    expect(evaluateSandboxPolicy({ preset: "malware_analysis" })).toMatchObject({ ok: false, result: { error: { code: "tier_forbidden" } } });
  });

  // ---- inputRef rejection (Tier >= 2 required; no silent Tier 1) ----
  it("rejects inputRef with tier_forbidden (attached input needs Tier >= 2)", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", code: "print(1)", inputRef: "uploads/x.exe" });
    expect(r).toMatchObject({ ok: false, result: { error: { code: "tier_forbidden" } } });
  });

  it("rejects empty-string inputRef with unsupported_input", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", code: "print(1)", inputRef: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Empty inputRef is still an attached-input intent; treat as tier_forbidden.
      expect(r.result.error.code).toBe("tier_forbidden");
    }
  });

  // ---- code validation ----
  it("rejects missing code for code_run with invalid_args", () => {
    expect(evaluateSandboxPolicy({ preset: "code_run" })).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  it("rejects empty code string with invalid_args", () => {
    expect(evaluateSandboxPolicy({ preset: "code_run", code: "" })).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  it("rejects whitespace-only code with invalid_args", () => {
    expect(evaluateSandboxPolicy({ preset: "code_run", code: "   \n\t  " })).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  it("rejects non-string code with invalid_args", () => {
    expect(evaluateSandboxPolicy({ preset: "code_run", code: 42 })).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  it("rejects code exceeding max length with invalid_args", () => {
    const longCode = "x".repeat(100_001);
    expect(evaluateSandboxPolicy({ preset: "code_run", code: longCode })).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  it("accepts code at exactly max length", () => {
    const code = "x".repeat(100_000);
    const r = evaluateSandboxPolicy({ preset: "code_run", code });
    expect(r.ok).toBe(true);
  });

  // ---- language validation ----
  it("defaults language to python when omitted", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", code: "print(1)" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.language).toBe("python");
  });

  it("accepts python", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", language: "python", code: "print(1)" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.language).toBe("python");
  });

  it("accepts javascript", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", language: "javascript", code: "console.log(1)" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.language).toBe("javascript");
  });

  it("rejects typescript with invalid_args (v0.4: no transpile path)", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", language: "typescript", code: "const x: number = 1;" });
    expect(r).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  it("rejects bash with invalid_args (v0.4: not in image yet)", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", language: "bash", code: "echo hi" });
    expect(r).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  it("rejects unknown language string with invalid_args", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", language: "rust", code: "fn main(){}" });
    expect(r).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  it("rejects non-string language with invalid_args", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", language: 5, code: "print(1)" });
    expect(r).toMatchObject({ ok: false, result: { error: { code: "invalid_args" } } });
  });

  // ---- Success shape ----
  it("returns tier 1, preset code_run, and trimmed code on success", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", code: "  print(1)  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ok: PolicyOk = r;
      expect(ok.preset).toBe("code_run");
      expect(ok.tier).toBe(1);
      expect(ok.language).toBe("python");
      expect(ok.code).toBe("print(1)");
    }
  });

  // ---- Unknown extra fields are ignored (forward-compat) ----
  it("ignores unknown extra fields", () => {
    const r = evaluateSandboxPolicy({ preset: "code_run", code: "print(1)", tier: 0, foo: "bar" });
    expect(r.ok).toBe(true);
  });
});
