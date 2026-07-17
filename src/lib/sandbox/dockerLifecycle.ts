/**
 * Docker CLI implementation of `SandboxLifecycle` (spec §5.2 D2 / §7 D4).
 *
 * Builds and runs:
 *
 *   docker run --rm \
 *     --network none \
 *     --memory <memLimitMb>m \
 *     --pids-limit 64 \
 *     --read-only \
 *     --tmpfs /tmp:rw,noexec,nosuid,size=64m \
 *     -v <hostStagingDir>:/work:ro \
 *     -w /work \
 *     <image> \
 *     <command>
 *
 * Language commands (image provides python + node runtimes):
 *   python:     python main.py
 *   javascript: node main.js
 *
 * Timeout: the spawned `docker run` is killed on `timeoutSec`. The container
 * itself is `--rm`, so killing the client-side `docker run` process is not
 * enough to tear down the container — we additionally `docker stop`/`kill`
 * the container if we still have its id. In v0.4 we use a simpler approach:
 * spawn with a Node-side timer and, on expiry, send SIGKILL to the child and
 * rely on `docker run --rm` to clean up. This is documented in the plan as
 * acceptable for v0.4.
 *
 * The `runCommand` function is injectable so tests can verify argv shape
 * without spawning Docker. The default implementation spawns the real `docker`
 * binary.
 */

import type { SandboxExecRequest, SandboxExecSuccess, SandboxLifecycle } from "./lifecycle";
import { defaultRunCommand, type RunCommandFn } from "./dockerDetect";

/** Default per-container memory cap (MB). */
const DEFAULT_MEM_LIMIT_MB = 256;

/** Per-container PID cap. */
const PIDS_LIMIT = 64;

/** tmpfs /tmp size. */
const TMPFS_SIZE = "64m";

/** Language → container command argv (appended after image name). */
function languageCommand(language: SandboxExecRequest["language"]): string[] {
  switch (language) {
    case "python":
      return ["python", "main.py"];
    case "javascript":
      return ["node", "main.js"];
    default:
      // Unreachable: policy rejects other languages. Defensive.
      return ["python", "main.py"];
  }
}

/**
 * Convert a host staging path to a form Docker Desktop accepts as a bind-mount
 * source. On Windows hosts, Docker Desktop accepts `C:\path\to\dir` in most
 * recent versions but historically needed `/c/path/to/dir`. We pass the native
 * path through; if a user hits a conversion issue, they can set
 * `SANDBOX_IMAGE` and run on a Linux host. Documented in the install skill.
 */
function toDockerVolumePath(hostPath: string): string {
  return hostPath;
}

/**
 * Build the `docker run` argv for a sandbox execution request.
 * Exported so tests can assert the argv shape without spawning Docker.
 */
export function buildDockerRunArgv(req: SandboxExecRequest): string[] {
  const memMb = req.memLimitMb ?? DEFAULT_MEM_LIMIT_MB;
  const vol = toDockerVolumePath(req.hostStagingDir);
  return [
    "run",
    "--rm",
    "--name", `sandbox-${req.runId}`,
    "--network", "none",
    "--memory", `${memMb}m`,
    "--pids-limit", String(PIDS_LIMIT),
    "--read-only",
    "--tmpfs", `/tmp:rw,noexec,nosuid,size=${TMPFS_SIZE}`,
    "-v", `${vol}:/work:ro`,
    "-w", "/work",
    req.image,
    ...languageCommand(req.language),
  ];
}

/**
 * Run `docker run` with a wall-clock timeout. Returns exec success.
 * Never throws — errors are surfaced via `exitCode: -1` + `stderr`.
 *
 * The timeout is a race between `runCommand` and a timer promise. The timer
 * handle is always cleared in `finally` so a fast success does not leave a
 * dangling reject promise (which would surface as an unhandled rejection
 * when the timer eventually fires).
 */
async function execDockerRun(
  argv: string[],
  timeoutMs: number,
  runCommand: RunCommandFn,
): Promise<SandboxExecSuccess> {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("__sandbox_timeout__"));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      runCommand(argv, { timeoutMs }),
      timeoutPromise,
    ]).catch((err): { exitCode: number; stdout: string; stderr: string; notFound?: boolean } => {
      if (timedOut) {
        return { exitCode: -1, stdout: "", stderr: `sandbox run timed out after ${timeoutMs}ms` };
      }
      return { exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Concrete `SandboxLifecycle` backed by the `docker` CLI.
 *
 * Constructed with an optional injectable `runCommand` (tests). The default
 * runner (`defaultRunCommand` from dockerDetect.ts) spawns the real `docker`.
 */
export class DockerLifecycle implements SandboxLifecycle {
  private runCommand: RunCommandFn;

  constructor(runCommand?: RunCommandFn) {
    this.runCommand = runCommand ?? defaultRunCommand;
  }

  async exec(req: SandboxExecRequest): Promise<SandboxExecSuccess> {
    const argv = buildDockerRunArgv(req);
    const timeoutMs = req.timeoutSec * 1000;
    return execDockerRun(argv, timeoutMs, this.runCommand);
  }
}
