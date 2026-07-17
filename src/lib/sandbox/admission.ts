/**
 * Admission control (defence layer: host resource guard, spec §7 / D4).
 *
 * Two independent gates:
 *  1. `getFreeMemoryPercent()` — best-effort free-memory probe.
 *     NOTE: `os.freemem()` / `os.totalmem()` report the Node process's view.
 *     On Docker Desktop (WSL2 on Windows) these numbers reflect the WSL VM,
 *     not the Windows host — admission may be approximate. We err on the side
 *     of rejecting (`insufficient_host_memory`) rather than OOMing the host.
 *  2. In-process concurrent-run semaphore (`withSandboxSlot`).
 *     Caps the number of simultaneously-running sandbox containers per app
 *     process. v0.4 default is 1.
 *
 * Both gates are checked in `checkAdmission()`, which returns `null` when
 * the run is admitted, or a `SandboxRunResult` failure.
 */

import { freemem, totalmem } from "node:os";
import { sandboxFail, type SandboxRunResult } from "./types";

/**
 * Best-effort free memory percentage (0-100).
 * Defensive: returns 0 on division by zero, clamps to 100 if free > total.
 */
export function getFreeMemoryPercent(): number {
  const total = totalmem();
  const free = freemem();
  if (total <= 0) return 0;
  const pct = Math.floor((free / total) * 100);
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/** Read the memory threshold env var (default 15%). Invalid → 15. */
function getMinFreeMemPercent(): number {
  const raw = Number(process.env.SANDBOX_MIN_FREE_MEM_PERCENT);
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) return 15;
  return raw;
}

/** Read the concurrent-limit env var (default 1). Invalid → 1. */
function getMaxConcurrent(): number {
  const raw = Number(process.env.SANDBOX_MAX_CONCURRENT);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

// In-process concurrent-run counter (module-private).
let activeRuns = 0;

/**
 * Check host-resource admission. Returns `null` if the run may proceed, or a
 * failure result if it must be rejected. Does NOT acquire the slot — that is
 * done by `withSandboxSlot` around the actual container execution.
 */
export function checkAdmission(): SandboxRunResult | null {
  const memPct = getFreeMemoryPercent();
  if (memPct < getMinFreeMemPercent()) {
    return sandboxFail(
      "insufficient_host_memory",
      `free memory ${memPct}% below threshold ${getMinFreeMemPercent()}%`,
    );
  }
  if (activeRuns >= getMaxConcurrent()) {
    return sandboxFail(
      "concurrent_limit",
      `concurrent sandbox runs at limit (${activeRuns}/${getMaxConcurrent()})`,
    );
  }
  return null;
}

/**
 * Acquire a concurrent-run slot, run `fn`, and always release the slot.
 * Propagates `fn`'s result (value or thrown error).
 */
export async function withSandboxSlot<T>(fn: () => Promise<T>): Promise<T> {
  // Increment first; the orchestrator already passed checkAdmission, so the
  // slot is expected to be available. If a concurrent caller sneaks in between
  // checkAdmission and here, the cap may be briefly exceeded by one — acceptable
  // for v0.4 (default limit 1, single-process). A strict semaphore would require
  // a queue, out of scope for the sync tool round (D6).
  activeRuns++;
  try {
    return await fn();
  } finally {
    activeRuns--;
    if (activeRuns < 0) activeRuns = 0; // defensive
  }
}

/** Test-only: reset the module-private concurrent counter. Not for production. */
export function _resetForTesting(): void {
  activeRuns = 0;
}
