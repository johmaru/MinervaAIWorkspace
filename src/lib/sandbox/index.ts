/**
 * Sandbox orchestrator: `runSandbox(args)`.
 *
 * Wires together the v0.4 defence stack for Tier 1 `code_run`:
 *
 *   1. Feature gate / Docker availability  (dockerDetect)
 *   2. Deterministic policy gate           (policy — Tier enforcement D7)
 *   3. Host-resource admission              (admission — mem % + concurrent D4)
 *   4. Image presence check                 (dockerDetect)
 *   5. Container execution                  (lifecycle — Docker CLI + named volumes)
 *   6. Output sanitization                  (sanitize — Tier 1 light D4)
 *
 * Staging uses Docker named volumes (not bind mounts) so the orchestrator
 * works regardless of whether the app runs natively, in Docker Compose,
 * or as a standalone exe. The lifecycle creates a volume, writes code into
 * it via a throwaway container, runs the code, and removes the volume.
 *
 * All failures return a structured `SandboxRunResult` with a stable error
 * code; `runSandbox` itself never throws.
 *
 * Spec: docs/superpowers/specs/2026-07-15-sandbox-architecture-design.md
 * Plan: docs/superpowers/plans/2026-07-17-sandbox-v0.4.md
 */

import { randomBytes } from "node:crypto";
import type OpenAI from "openai";
import { evaluateSandboxPolicy } from "./policy";
import { checkAdmission, withSandboxSlot } from "./admission";
import {
  isDockerAvailable,
  isSandboxImagePresent,
  isSandboxForcedOff,
  getSandboxImage,
  shouldExposeSandboxTool,
} from "./dockerDetect";
import { sanitizeToolOutput } from "./sanitize";
import { DockerLifecycle } from "./dockerLifecycle";
import { sandboxFail, type SandboxRunResult } from "./types";
import { getSandboxToolDefinition } from "./toolDef";

/** Read the default timeout env var (default 30s). Invalid → 30. */
function getDefaultTimeoutSec(): number {
  const raw = Number(process.env.SANDBOX_DEFAULT_TIMEOUT_SEC);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.floor(raw);
}

/** Read the stdout/stderr cap env var (default 4096 chars). Invalid → 4096. */
function getStdoutMaxBytes(): number {
  const raw = Number(process.env.SANDBOX_STDOUT_MAX_BYTES);
  if (!Number.isFinite(raw) || raw < 1) return 4096;
  return Math.floor(raw);
}

/** Generate a runId (URL-safe, no dashes to keep container names simple). */
function newRunId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Execute a sandbox run. Never throws — all failure paths return a structured
 * `SandboxRunResult` failure.
 *
 * @param args Raw tool-call arguments (unknown — policy gate validates).
 */
export async function runSandbox(args: unknown): Promise<SandboxRunResult> {
  const startedAt = Date.now();

  // 1. Feature gate: if forced off, the tool should not have been offered.
  //    Fail closed with docker_unavailable for safety.
  if (isSandboxForcedOff()) {
    return sandboxFail("docker_unavailable", "sandbox feature is disabled (SANDBOX_ENABLED=false)");
  }

  // 2. Policy gate (deterministic, pure).
  const policy = evaluateSandboxPolicy(args);
  if (!policy.ok) return policy.result;

  // 3. Docker availability.
  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    return sandboxFail("docker_unavailable", "Docker daemon is not reachable");
  }

  // 4. Image presence.
  const image = getSandboxImage();
  const imageOk = await isSandboxImagePresent(image);
  if (!imageOk) {
    return sandboxFail("image_missing", `sandbox image not found: ${image}. Build it with: docker build -t ${image} sandbox/python`);
  }

  // 5. Host-resource admission.
  const admission = checkAdmission();
  if (admission) return admission;

  // 6. Execute under the concurrent slot. Lifecycle handles volume
  //    create/write/run/rm internally.
  const runId = newRunId();
  const maxChars = getStdoutMaxBytes();
  const timeoutSec = getDefaultTimeoutSec();
  const lifecycle = new DockerLifecycle();

  return withSandboxSlot(async (): Promise<SandboxRunResult> => {
    try {
      const exec = await lifecycle.exec({
        runId,
        image,
        language: policy.language,
        code: policy.code,
        timeoutSec,
        memLimitMb: 256,
      });

      // 7. Sanitize output (Tier 1 light).
      const out = sanitizeToolOutput(exec.stdout, maxChars);
      const err = sanitizeToolOutput(exec.stderr, maxChars);

      // Map timeout → ok:false, code:timeout (clearer tool semantics).
      if (exec.timedOut) {
        return {
          ok: false,
          error: {
            code: "timeout",
            message: `sandbox run exceeded ${timeoutSec}s timeout`,
          },
        };
      }

      // Container failed to start (docker not found, spawn error, etc.)
      if (exec.exitCode === -1 && !exec.stdout && !exec.stderr.includes("timed out")) {
        return sandboxFail("container_failed", exec.stderr || "container failed to start");
      }

      return {
        ok: true,
        preset: "code_run",
        tier: 1,
        durationMs: Date.now() - startedAt,
        exitCode: exec.exitCode,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
      };
    } catch (err) {
      return sandboxFail(
        "internal_error",
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

/**
 * Return the sandbox tool definitions to expose for a given request, or `[]`
 * when the feature is off (no Docker, image missing, or forced off).
 *
 * Called once per chat request from the chat route. The Docker probe only
 * runs when this function is invoked, not at module import time.
 */
export async function getSandboxToolsForRequest(): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]> {
  const expose = await shouldExposeSandboxTool();
  return expose ? [getSandboxToolDefinition()] : [];
}

/** Re-export the tool definition for callers that want it directly. */
export { getSandboxToolDefinition } from "./toolDef";
