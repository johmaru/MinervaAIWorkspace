/**
 * Sandbox types, error codes, and preset metadata.
 *
 * v0.4 scope (per implementation plan):
 * - Only `code_run` preset is implemented (Tier 1).
 * - Only `python` and `javascript` languages are supported by the prebuilt
 *   image. `typescript` and `bash` are declared in the union for forward
 *   compatibility but rejected by the policy gate as `invalid_args` until a
 *   matching image / transpile path exists.
 * - `file_inspect` (Tier 2) and `malware_analysis` (Tier 3) presets are
 *   declared but not implemented; the policy gate rejects them with
 *   `tier_forbidden`.
 *
 * Spec: docs/superpowers/specs/2026-07-15-sandbox-architecture-design.md
 * Plan: docs/superpowers/plans/2026-07-17-sandbox-v0.4.md
 */

/** Preset names. Only `code_run` is implemented in v0.4. */
export type SandboxPresetName = "code_run" | "file_inspect" | "malware_analysis";

/**
 * Stable error codes returned to the tool layer / LLM.
 * Never change existing codes; only append new ones.
 */
export type SandboxErrorCode =
  | "docker_unavailable"
  | "image_missing"
  | "insufficient_host_memory"
  | "concurrent_limit"
  | "invalid_args"
  | "preset_unknown"
  | "tier_forbidden"
  | "unsupported_input"
  | "staging_failed"
  | "timeout"
  | "container_failed"
  | "internal_error";

/**
 * Arguments accepted by `sandbox_run` / `runSandbox`.
 * - `preset`: required. v0.4 only honours `code_run`.
 * - `language`: optional, defaults to `python` in the policy gate.
 *   v0.4 image supports `python` and `javascript` only.
 * - `code`: inline source string. Required for `code_run`.
 * - `inputRef`: reserved for Tier >= 2 attached-file analysis. Any value is
 *   rejected in v0.4 (no silent Tier 1 downgrade — see spec §7.2).
 */
export type SandboxRunArgs = {
  preset: SandboxPresetName;
  language?: "python" | "javascript" | "typescript" | "bash";
  code?: string;
  inputRef?: string;
};

/**
 * Successful sandbox run result.
 * `tier` mirrors the preset's security tier (1 for `code_run`).
 */
export type SandboxRunSuccess = {
  ok: true;
  preset: string;
  tier: 0 | 1 | 2 | 3;
  durationMs: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  analysis?: Record<string, unknown>;
};

/** Failed sandbox run result with a stable error code. */
export type SandboxRunFailure = {
  ok: false;
  error: { code: SandboxErrorCode; message: string };
};

/** Union result returned by `runSandbox`. */
export type SandboxRunResult = SandboxRunSuccess | SandboxRunFailure;

/**
 * Per-preset metadata. `implemented` flags whether the preset has a runnable
 * pipeline in the current build. `timeoutSec` is the preset default; the
 * orchestrator may override via `SANDBOX_DEFAULT_TIMEOUT_SEC`.
 */
export const PRESET_META: Record<
  SandboxPresetName,
  { securityTier: 0 | 1 | 2 | 3; timeoutSec: number; implemented: boolean }
> = {
  code_run: { securityTier: 1, timeoutSec: 30, implemented: true },
  file_inspect: { securityTier: 2, timeoutSec: 60, implemented: false },
  malware_analysis: { securityTier: 3, timeoutSec: 60, implemented: false },
};

/** Build a failure result. Convenience for short-circuit returns. */
export function sandboxFail(code: SandboxErrorCode, message: string): SandboxRunResult {
  return { ok: false, error: { code, message } };
}
