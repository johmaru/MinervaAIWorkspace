/**
 * Docker CLI implementation of `SandboxLifecycle` (spec §5.2 D2 / §7 D4).
 *
 * Uses Docker named volumes instead of bind mounts so it works regardless
 * of whether the app runs natively, in Docker Compose, or as an exe.
 * Bind mounts require the host Docker daemon to see the staging path, which
 * fails in Docker-in-Docker sibling patterns (container paths ≠ host paths).
 *
 * Flow per exec:
 *   1. `docker volume create sandbox-staging-<runId>`
 *   2. `docker run --rm -v sandbox-staging-<runId>:/work:rw <image> \
 *        sh -c "echo '<base64>' | base64 -d > /work/<file>"`
 *      (writes inline code into the volume via a throwaway container)
 *   3. `docker run --rm --network none --memory ... --read-only ... \
 *        -v sandbox-staging-<runId>:/work:ro <image> <command>`
 *   4. `docker volume rm sandbox-staging-<runId>`
 *
 * Language commands (image provides python + node runtimes):
 *   python:     python main.py
 *   javascript: node main.js
 *
 * The `runCommand` function is injectable so tests can verify argv shape
 * without spawning Docker.
 */

import type { SandboxExecRequest, SandboxExecSuccess, SandboxLifecycle } from "./lifecycle";
import { defaultRunCommand, type RunCommandFn } from "./dockerDetect";

/** Default per-container memory cap (MB). */
const DEFAULT_MEM_LIMIT_MB = 256;

/** Per-container PID cap. */
const PIDS_LIMIT = 64;

/** tmpfs /tmp size. */
const TMPFS_SIZE = "64m";

/** Language → staging filename. */
function filenameForLanguage(language: SandboxExecRequest["language"]): string {
  switch (language) {
    case "python":
      return "main.py";
    case "javascript":
      return "main.js";
    default:
      return "main.txt";
  }
}

/** Language → container command argv (appended after image name). */
function languageCommand(language: SandboxExecRequest["language"]): string[] {
  switch (language) {
    case "python":
      return ["python", "main.py"];
    case "javascript":
      return ["node", "main.js"];
    default:
      return ["python", "main.py"];
  }
}

/** Volume name for a run. */
function volumeName(runId: string): string {
  return `sandbox-staging-${runId}`;
}

/**
 * Build the `docker run` argv for the code-execution container (step 3).
 * Exported so tests can assert the argv shape without spawning Docker.
 */
export function buildDockerRunArgv(req: SandboxExecRequest): string[] {
  const memMb = req.memLimitMb ?? DEFAULT_MEM_LIMIT_MB;
  const vol = volumeName(req.runId);
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
 * Build the argv to write code into the volume via a throwaway container
 * (step 2). The code is base64-encoded to avoid shell injection from user
 * code. base64 output is [A-Za-z0-9+/=] only — safe inside single quotes.
 */
export function buildWriteCodeArgv(req: SandboxExecRequest): string[] {
  const vol = volumeName(req.runId);
  const filename = filenameForLanguage(req.language);
  const codeB64 = Buffer.from(req.code, "utf8").toString("base64");
  return [
    "run",
    "--rm",
    "--network", "none",
    "-v", `${vol}:/work:rw`,
    "-w", "/work",
    req.image,
    "sh", "-c", `echo '${codeB64}' | base64 -d > /work/${filename}`,
  ];
}

/** Build the `docker volume create` argv (step 1). */
export function buildVolumeCreateArgv(runId: string): string[] {
  return ["volume", "create", volumeName(runId)];
}

/** Build the `docker volume rm` argv (step 4). */
export function buildVolumeRmArgv(runId: string): string[] {
  return ["volume", "rm", volumeName(runId)];
}

/**
 * Run `docker run` with a wall-clock timeout. Returns exec success.
 * Never throws — errors are surfaced via `exitCode: -1` + `stderr`.
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
 * Uses named volumes for staging so it works in Docker-in-Docker sibling
 * patterns (app in Compose, sandbox spawned via host Docker socket).
 */
export class DockerLifecycle implements SandboxLifecycle {
  private runCommand: RunCommandFn;

  constructor(runCommand?: RunCommandFn) {
    this.runCommand = runCommand ?? defaultRunCommand;
  }

  async exec(req: SandboxExecRequest): Promise<SandboxExecSuccess> {
    const timeoutMs = req.timeoutSec * 1000;
    const writeTimeoutMs = Math.min(timeoutMs, 10_000);

    // Step 1: create the named volume.
    const createArgv = buildVolumeCreateArgv(req.runId);
    const createResult = await this.runCommand(createArgv, { timeoutMs: 10_000 });
    if (createResult.exitCode !== 0) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `failed to create staging volume: ${createResult.stderr}`,
        timedOut: false,
      };
    }

    try {
      // Step 2: write code into the volume via a throwaway container.
      const writeArgv = buildWriteCodeArgv(req);
      const writeResult = await this.runCommand(writeArgv, { timeoutMs: writeTimeoutMs });
      if (writeResult.exitCode !== 0) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: `failed to write code to staging volume: ${writeResult.stderr}`,
          timedOut: false,
        };
      }

      // Step 3: run the code.
      const runArgv = buildDockerRunArgv(req);
      return await execDockerRun(runArgv, timeoutMs, this.runCommand);
    } finally {
      // Step 4: always clean up the volume.
      const rmArgv = buildVolumeRmArgv(req.runId);
      await this.runCommand(rmArgv, { timeoutMs: 10_000 }).catch(() => { /* best-effort */ });
    }
  }
}
