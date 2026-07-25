/**
 * Deterministic policy gate (defence layer 1, spec §6 layer 1 / §7.2 D7).
 *
 * Rules (v0.4):
 *  1. Parse/validate shape → else `invalid_args`.
 *  2. Unknown preset → `preset_unknown`.
 *  3. `file_inspect` / `malware_analysis` → `tier_forbidden` (not implemented).
 *  4. `inputRef` present (any value) → `tier_forbidden`. Attached scripts /
 *     binaries require Tier >= 2; v0.4 has no implement path, and we never
 *     silently downgrade to Tier 1 (spec §7.2).
 *  5. `code` required for `code_run`; non-empty string; ≤ 100_000 chars.
 *  6. `language` defaults to `python`; only `python` and `javascript` accepted
 *     in v0.4 (the prebuilt image ships both runtimes). `typescript` / `bash`
 *     are rejected as `invalid_args` until a transpile path / bash image exists.
 *  7. Success only: preset `code_run`, inline code, tier 1.
 *
 * This gate is pure / synchronous / side-effect-free. It does not touch Docker,
 * memory, or the filesystem. All of those are later orchestrator concerns.
 */

import { PRESET_META, sandboxFail, type SandboxPresetName, type SandboxRunResult } from "./types";

/** Languages the v0.4 prebuilt image can execute. */
export const SUPPORTED_LANGUAGES = ["python", "javascript"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Maximum code length accepted for `code_run` (chars). */
export const MAX_CODE_LENGTH = 100_000;

/** Validated, policy-approved args ready for the orchestrator. */
export type PolicyOk = {
  ok: true;
  preset: "code_run"; // only implemented preset in v0.4
  tier: 1;
  language: SupportedLanguage;
  code: string; // trimmed
  /** Validated output file mappings (containerPath → workspacePath). */
  outputFiles?: Array<{ containerPath: string; workspacePath: string }>;
};

/** Policy rejection — carries a fully-formed failure result. */
export type PolicyErr = { ok: false; result: SandboxRunResult };

/** Outcome of policy evaluation. */
export type PolicyOutcome = PolicyOk | PolicyErr;

const KNOWN_PRESETS: ReadonlySet<SandboxPresetName> = new Set([
  "code_run",
  "file_inspect",
  "malware_analysis",
]);

/**
 * Evaluate sandbox args against the v0.4 policy. Pure function.
 * Never throws — malformed input yields `invalid_args`.
 */
export function evaluateSandboxPolicy(args: unknown): PolicyOutcome {
  // 1. Shape validation
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, result: sandboxFail("invalid_args", "args must be an object") };
  }
  const a = args as { preset?: unknown; language?: unknown; code?: unknown; inputRef?: unknown; outputFiles?: unknown };

  // 2. Preset presence + type
  if (a.preset === undefined || a.preset === null) {
    return { ok: false, result: sandboxFail("invalid_args", "preset is required") };
  }
  if (typeof a.preset !== "string") {
    return { ok: false, result: sandboxFail("invalid_args", "preset must be a string") };
  }
  if (!KNOWN_PRESETS.has(a.preset as SandboxPresetName)) {
    return { ok: false, result: sandboxFail("preset_unknown", `unknown preset: ${a.preset}`) };
  }
  const preset = a.preset as SandboxPresetName;

  // 3. Unimplemented presets → tier_forbidden (no silent Tier 1 downgrade)
  if (!PRESET_META[preset].implemented) {
    return {
      ok: false,
      result: sandboxFail(
        "tier_forbidden",
        `preset "${preset}" is not implemented in v0.4 (requires Tier ${PRESET_META[preset].securityTier})`,
      ),
    };
  }

  // 4. inputRef present → Tier >= 2 required. v0.4 rejects (no implement path).
  if (a.inputRef !== undefined && a.inputRef !== null) {
    return {
      ok: false,
      result: sandboxFail(
        "tier_forbidden",
        "inputRef is not supported in v0.4 (attached input requires Tier >= 2)",
      ),
    };
  }

  // 5. code required for code_run
  if (a.code === undefined || a.code === null) {
    return { ok: false, result: sandboxFail("invalid_args", "code is required for code_run") };
  }
  if (typeof a.code !== "string") {
    return { ok: false, result: sandboxFail("invalid_args", "code must be a string") };
  }
  const code = a.code.trim();
  if (code.length === 0) {
    return { ok: false, result: sandboxFail("invalid_args", "code must not be empty") };
  }
  if (code.length > MAX_CODE_LENGTH) {
    return {
      ok: false,
      result: sandboxFail("invalid_args", `code exceeds max length of ${MAX_CODE_LENGTH} chars`),
    };
  }

  // 6. language default + validation
  let language: SupportedLanguage;
  if (a.language === undefined || a.language === null) {
    language = "python";
  } else if (typeof a.language !== "string") {
    return { ok: false, result: sandboxFail("invalid_args", "language must be a string") };
  } else {
    if (!SUPPORTED_LANGUAGES.includes(a.language as SupportedLanguage)) {
      return {
        ok: false,
        result: sandboxFail("invalid_args", `language "${a.language}" is not supported in v0.4`),
      };
    }
    language = a.language as SupportedLanguage;
  }

  // 7. outputFiles (optional): validate each entry's paths.
  let outputFiles: Array<{ containerPath: string; workspacePath: string }> | undefined;
  if (a.outputFiles !== undefined && a.outputFiles !== null) {
    if (!Array.isArray(a.outputFiles)) {
      return { ok: false, result: sandboxFail("invalid_args", "outputFiles must be an array") };
    }
    outputFiles = [];
    for (const entry of a.outputFiles) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, result: sandboxFail("invalid_args", "outputFiles entries must be objects") };
      }
      const e = entry as { containerPath?: unknown; workspacePath?: unknown };
      if (typeof e.containerPath !== "string" || typeof e.workspacePath !== "string") {
        return { ok: false, result: sandboxFail("invalid_args", "outputFiles entries must have containerPath and workspacePath strings") };
      }
      const containerPath = e.containerPath.trim();
      const workspacePath = e.workspacePath.trim();
      // containerPath must start with /out/ and contain no .. segments
      if (!containerPath.startsWith("/out/")) {
        return { ok: false, result: sandboxFail("invalid_args", `containerPath must start with /out/ (got: ${containerPath})`) };
      }
      if (containerPath.includes("..")) {
        return { ok: false, result: sandboxFail("invalid_args", `containerPath must not contain .. (got: ${containerPath})`) };
      }
      // workspacePath must be relative (no leading /) and contain no .. segments
      if (workspacePath.startsWith("/")) {
        return { ok: false, result: sandboxFail("invalid_args", `workspacePath must be relative (got: ${workspacePath})`) };
      }
      if (workspacePath.includes("..")) {
        return { ok: false, result: sandboxFail("invalid_args", `workspacePath must not contain .. (got: ${workspacePath})`) };
      }
      if (workspacePath.length === 0) {
        return { ok: false, result: sandboxFail("invalid_args", "workspacePath must not be empty") };
      }
      outputFiles.push({ containerPath, workspacePath });
    }
  }

  // 8. Success
  return {
    ok: true,
    preset: "code_run",
    tier: 1,
    language,
    code,
    outputFiles,
  };
}
