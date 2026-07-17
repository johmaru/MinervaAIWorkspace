/**
 * Docker availability detection (spec §7.1 D1).
 *
 * The sandbox tool is only exposed to the LLM when Docker is reachable AND the
 * prebuilt image is present (or `SANDBOX_ENABLED=true` forces the tool on,
 * in which case missing Docker yields a runtime `docker_unavailable` error
 * rather than hiding the tool).
 *
 * All shell access is funnelled through an injectable `runCommand` so tests
 * can stub the `docker` CLI without spawning real processes.
 */

import { spawn } from "node:child_process";

/** Result of running an external command (exit + captured streams). */
export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when `docker` binary was not found (ENOENT). */
  notFound?: boolean;
};

/** Injectable runner. Default uses `docker` from PATH. */
export type RunCommandFn = (argv: string[], opts?: { timeoutMs?: number }) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 10_000;

/** Default runner: spawns `docker` with the given argv. */
export const defaultRunCommand: RunCommandFn = (argv, opts) => {
  return new Promise((resolve) => {
    const child = spawn("docker", argv, {
      shell: false,
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      // ENOENT: docker not installed / not on PATH
      const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
      resolve({ exitCode: -1, stdout, stderr, notFound });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
};

// Injectable runner so tests can stub the docker CLI. Module-level mutable.
let runCommand: RunCommandFn = defaultRunCommand;

/** Replace the runner (tests only). */
export function _setRunCommand(fn: RunCommandFn): void {
  runCommand = fn;
}

/** Restore the default runner (tests only). */
export function _resetRunCommand(): void {
  runCommand = defaultRunCommand;
}

/** `true` only when `SANDBOX_ENABLED=false` explicitly forces the feature off. */
export function isSandboxForcedOff(): boolean {
  return process.env.SANDBOX_ENABLED === "false";
}

/**
 * `true` only when `SANDBOX_ENABLED=true` requires Docker (tool always exposed;
 * missing Docker yields a runtime `docker_unavailable` error).
 */
export function isSandboxForcedOn(): boolean {
  return process.env.SANDBOX_ENABLED === "true";
}

/**
 * Probe whether the Docker daemon is reachable via `docker info`.
 * `auto` (default) and `true` modes both call this.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const r = await runCommand(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 5000 });
    return r.exitCode === 0 && !r.notFound;
  } catch {
    return false;
  }
}

/**
 * Probe whether a specific image is present locally.
 */
export async function isSandboxImagePresent(image: string): Promise<boolean> {
  try {
    // `docker image inspect` exits 0 when present, 1 when absent.
    const r = await runCommand(["image", "inspect", image], { timeoutMs: 5000 });
    return r.exitCode === 0 && !r.notFound;
  } catch {
    return false;
  }
}

/** Default image tag (env-overridable). */
export function getSandboxImage(): string {
  return process.env.SANDBOX_IMAGE || "umanschat-sandbox-python:v0.4";
}

/**
 * Decide whether to expose `sandbox_run` to the LLM for this request.
 *
 * - `SANDBOX_ENABLED=false` → never.
 * - `SANDBOX_ENABLED=true`  → always (Docker checked at run time).
 * - `SANDBOX_ENABLED=auto` (default) → only when Docker is reachable AND
 *   the prebuilt image is present.
 *
 * This is async because it shells out to `docker`. The chat route calls it
 * once per request when assembling the tool list.
 */
export async function shouldExposeSandboxTool(): Promise<boolean> {
  if (isSandboxForcedOff()) return false;
  if (isSandboxForcedOn()) return true;
  // auto
  const dockerOk = await isDockerAvailable();
  if (!dockerOk) return false;
  return isSandboxImagePresent(getSandboxImage());
}
