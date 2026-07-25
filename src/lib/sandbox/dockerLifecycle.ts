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

/** Volume name for sandbox output recovery. */
function outputVolumeName(runId: string): string {
  return `sandbox-output-${runId}`;
}

/**
 * Build the `docker run` argv for the code-execution container (step 3).
 * Exported so tests can assert the argv shape without spawning Docker.
 */
export function buildDockerRunArgv(req: SandboxExecRequest): string[] {
  const memMb = req.memLimitMb ?? DEFAULT_MEM_LIMIT_MB;
  const vol = volumeName(req.runId);
  const hasOutput = !!(req.outputFiles && req.outputFiles.length > 0);
  const outVol = outputVolumeName(req.runId);

  // Determine the workspace mount path (shared mount or per-user)
  // When WORKSPACE_HOST_PATH is set, workspace is at /app/workspace.
  // Otherwise, fall back to per-user workspace (also under /app or cwd).
  // We mount it read-only into /workspace so sandbox code can read files.
  const argv = [
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
  ];

  // Mount a writable output volume at /out when output files are requested.
  // The root fs is read-only, so /out is the only place sandbox code can write.
  if (hasOutput) {
    argv.push("-v", `${outVol}:/out:rw`);
  }

  // Mount workspace read-only if available (enables file reading in sandbox)
  // The workspace path is resolved the same way as getWorkspaceRoot.
  const hostPath = process.env.WORKSPACE_HOST_PATH;
  if (hostPath) {
    // Shared mount mode: /app/workspace is the container-side mount target
    argv.push("-v", "/app/workspace:/workspace:ro");
  } else {
    // Per-user mode: mount the per-user workspace directory
    // This requires the userId to be passed through; for now, skip if no
    // shared mount is configured (sandbox workspace access is opt-in)
  }

  argv.push(req.image, ...languageCommand(req.language));
  return argv;
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

/** Build the `docker volume create` argv for the output volume. */
export function buildOutputVolumeCreateArgv(runId: string): string[] {
  return ["volume", "create", outputVolumeName(runId)];
}

/** Build the `docker volume rm` argv for the output volume. */
export function buildOutputVolumeRmArgv(runId: string): string[] {
  return ["volume", "rm", outputVolumeName(runId)];
}

/**
 * Build the argv to chown the output volume to the sandbox user (uid 10001).
 * Docker named volumes initialize root:root mode 0755, but the sandbox image
 * runs as USER sandbox (uid 10001). Without this init step, sandbox code
 * cannot write to /out. Runs as root (--user 0) in a throwaway container.
 * The python image ships `chown` (coreutils), so no second image needed.
 */
export function buildOutputVolumeInitArgv(runId: string, image: string): string[] {
  return [
    "run",
    "--rm",
    "--user", "0",
    "--network", "none",
    "-v", `${outputVolumeName(runId)}:/out`,
    image,
    "chown", "10001:10001", "/out",
  ];
}

/**
 * Build the argv to recover a single output file from the output volume via
 * a throwaway container. Reuses req.image (python image has `cat`) instead of
 * alpine to avoid pulling a second image. The file is printed to stdout and
 * captured by the orchestrator.
 */
export function buildOutputRecoveryArgv(runId: string, image: string, containerPath: string): string[] {
  return [
    "run",
    "--rm",
    "--network", "none",
    "--memory", "64m",
    "--pids-limit", "16",
    "-v", `${outputVolumeName(runId)}:/out:ro`,
    image,
    "cat", containerPath,
  ];
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
    const hasOutput = !!(req.outputFiles && req.outputFiles.length > 0);

    // Step 1: create the named staging volume.
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

    // Step 1b: create the output volume when output files are requested.
    if (hasOutput) {
      const outCreateArgv = buildOutputVolumeCreateArgv(req.runId);
      const outCreateResult = await this.runCommand(outCreateArgv, { timeoutMs: 10_000 });
      if (outCreateResult.exitCode !== 0) {
        // Best-effort cleanup of the staging volume before bailing.
        await this.runCommand(buildVolumeRmArgv(req.runId), { timeoutMs: 10_000 }).catch(() => {});
        return {
          exitCode: -1,
          stdout: "",
          stderr: `failed to create output volume: ${outCreateResult.stderr}`,
          timedOut: false,
        };
      }
      // Step 1c: chown the output volume root to the sandbox user (uid 10001).
      // Docker named volumes initialize root:root 0755; the sandbox image runs
      // as USER sandbox (uid 10001), so without chown the code cannot write.
      const initArgv = buildOutputVolumeInitArgv(req.runId, req.image);
      const initResult = await this.runCommand(initArgv, { timeoutMs: 10_000 });
      if (initResult.exitCode !== 0) {
        await this.runCommand(buildOutputVolumeRmArgv(req.runId), { timeoutMs: 10_000 }).catch(() => {});
        await this.runCommand(buildVolumeRmArgv(req.runId), { timeoutMs: 10_000 }).catch(() => {});
        return {
          exitCode: -1,
          stdout: "",
          stderr: `failed to chown output volume: ${initResult.stderr}`,
          timedOut: false,
        };
      }
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
      const execResult = await execDockerRun(runArgv, timeoutMs, this.runCommand);

      // Step 3b: recover output files from the output volume. Even if the
      // run failed or timed out, the code may have written partial output
      // before dying — attempt recovery regardless. Missing files are
      // surfaced as a stderr note on the individual entry, not a hard failure.
      if (hasOutput && req.outputFiles) {
        const outputs: Record<string, string> = {};
        for (const { containerPath } of req.outputFiles) {
          const recoveryArgv = buildOutputRecoveryArgv(req.runId, req.image, containerPath);
          const recoveryResult = await this.runCommand(recoveryArgv, { timeoutMs: 10_000 }).catch((err) => ({
            exitCode: -1,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
          }));
          if (recoveryResult.exitCode === 0) {
            const MAX_OUTPUT_BYTES = 16 * 1024 * 1024; // 16MB
            if (recoveryResult.stdout.length > MAX_OUTPUT_BYTES) {
              outputs[containerPath] = "";
              execResult.stderr += `\n[output file too large: ${containerPath} (${recoveryResult.stdout.length} bytes, max ${MAX_OUTPUT_BYTES})]`;
            } else {
              outputs[containerPath] = recoveryResult.stdout;
            }
          } else {
            // File missing or read error: record an empty string so the
            // orchestrator can detect it (absent key = never attempted,
            // present key with "" = attempted but failed). Prefix stderr.
            outputs[containerPath] = "";
            execResult.stderr += `\n[output recovery failed for ${containerPath}: ${recoveryResult.stderr}]`;
          }
        }
        execResult.outputs = outputs;
      }

      return execResult;
    } finally {
      // Step 4: always clean up both volumes.
      await this.runCommand(buildVolumeRmArgv(req.runId), { timeoutMs: 10_000 }).catch(() => { /* best-effort */ });
      if (hasOutput) {
        await this.runCommand(buildOutputVolumeRmArgv(req.runId), { timeoutMs: 10_000 }).catch(() => { /* best-effort */ });
      }
    }
  }
}
