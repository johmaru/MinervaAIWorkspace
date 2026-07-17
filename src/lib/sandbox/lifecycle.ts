/**
 * SandboxLifecycle interface + request/result types.
 *
 * In v0.4 the only implementation is `DockerLifecycle` (dockerLifecycle.ts),
 * which shells out to the `docker` CLI. The interface exists so that a future
 * Compose-split service (HTTP implementation, spec §5.2 D2 phase B) can be
 * dropped in without touching the orchestrator.
 *
 * Spec: docs/superpowers/specs/2026-07-15-sandbox-architecture-design.md §5.2
 */

/** Request to execute a preset run inside a sandbox. */
export type SandboxExecRequest = {
  runId: string;
  image: string;
  /** Language chosen by the policy gate (python | javascript in v0.4). */
  language: "python" | "javascript";
  /** Inline source code to write into the sandbox volume. */
  code: string;
  /** Hard wall-clock timeout in seconds. Container is killed on expiry. */
  timeoutSec: number;
  /** Container memory cap in MB (e.g. 256). */
  memLimitMb?: number;
};

/** Result of a sandbox execution. Always returns (never throws). */
export type SandboxExecSuccess = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if the container was killed for exceeding the timeout. */
  timedOut: boolean;
};

/**
 * Lifecycle interface. Implementations must:
 *  - Never run with a user-controlled image name (image comes from env only).
 *  - Never pass host paths through to the LLM (paths stay in the orchestrator).
 *  - Always clean up the container (`--rm` or explicit `docker rm`).
 *  - Enforce `--network none`, memory/pids limits, read-only root fs.
 */
export interface SandboxLifecycle {
  exec(req: SandboxExecRequest): Promise<SandboxExecSuccess>;
}
