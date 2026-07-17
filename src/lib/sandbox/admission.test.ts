// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock node:os so tests can control free/total memory without touching the
// real host. Named imports in admission.ts (freemem/totalmem) resolve through
// this mock. ESM namespaces are non-configurable, so vi.spyOn(os, ...) fails;
// vi.mock is the correct path.
vi.mock("node:os", () => ({
  freemem: vi.fn(() => 8 * 1024 ** 3),
  totalmem: vi.fn(() => 16 * 1024 ** 3),
}));

import { freemem, totalmem } from "node:os";
import { getFreeMemoryPercent, checkAdmission, withSandboxSlot, _resetForTesting } from "./admission";

describe("getFreeMemoryPercent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 50 when free is half of total", () => {
    vi.mocked(freemem).mockReturnValue(8 * 1024 ** 3);
    vi.mocked(totalmem).mockReturnValue(16 * 1024 ** 3);
    expect(getFreeMemoryPercent()).toBe(50);
  });

  it("returns 100 when free equals total", () => {
    vi.mocked(freemem).mockReturnValue(16 * 1024 ** 3);
    vi.mocked(totalmem).mockReturnValue(16 * 1024 ** 3);
    expect(getFreeMemoryPercent()).toBe(100);
  });

  it("returns 0 when free is 0", () => {
    vi.mocked(freemem).mockReturnValue(0);
    vi.mocked(totalmem).mockReturnValue(16 * 1024 ** 3);
    expect(getFreeMemoryPercent()).toBe(0);
  });

  it("returns 0 when total is 0 (avoids NaN)", () => {
    vi.mocked(freemem).mockReturnValue(0);
    vi.mocked(totalmem).mockReturnValue(0);
    expect(getFreeMemoryPercent()).toBe(0);
  });

  it("clamps to 100 if free > total (defensive)", () => {
    vi.mocked(freemem).mockReturnValue(20 * 1024 ** 3);
    vi.mocked(totalmem).mockReturnValue(16 * 1024 ** 3);
    expect(getFreeMemoryPercent()).toBe(100);
  });
});

describe("checkAdmission", () => {
  beforeEach(() => {
    vi.stubEnv("SANDBOX_MIN_FREE_MEM_PERCENT", "15");
    vi.stubEnv("SANDBOX_MAX_CONCURRENT", "1");
    _resetForTesting();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("allows when memory is plentiful and no concurrent runs", () => {
    vi.mocked(freemem).mockReturnValue(8 * 1024 ** 3);
    vi.mocked(totalmem).mockReturnValue(16 * 1024 ** 3);
    expect(checkAdmission()).toBeNull();
  });

  it("rejects when free memory below threshold", () => {
    vi.mocked(freemem).mockReturnValue(1 * 1024 ** 3); // ~6.25%
    vi.mocked(totalmem).mockReturnValue(16 * 1024 ** 3);
    const r = checkAdmission();
    expect(r).not.toBeNull();
    expect(r && r.ok === false && r.error.code).toBe("insufficient_host_memory");
  });

  it("allows at exactly the threshold (>= threshold)", () => {
    // 15% of 16 GB = 2.4 GB. Free == threshold → allowed (not < threshold).
    vi.mocked(freemem).mockReturnValue(2.4 * 1024 ** 3);
    vi.mocked(totalmem).mockReturnValue(16 * 1024 ** 3);
    expect(checkAdmission()).toBeNull();
  });

  it("respects custom threshold env var", () => {
    vi.stubEnv("SANDBOX_MIN_FREE_MEM_PERCENT", "50");
    vi.mocked(freemem).mockReturnValue(6 * 1024 ** 3); // 37.5%
    vi.mocked(totalmem).mockReturnValue(16 * 1024 ** 3);
    const r = checkAdmission();
    expect(r && r.ok === false && r.error.code).toBe("insufficient_host_memory");
  });
});

describe("withSandboxSlot", () => {
  beforeEach(() => {
    vi.stubEnv("SANDBOX_MAX_CONCURRENT", "1");
    vi.stubEnv("SANDBOX_MIN_FREE_MEM_PERCENT", "15");
    _resetForTesting();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("runs a function and returns its value", async () => {
    const result = await withSandboxSlot(async () => 42);
    expect(result).toBe(42);
  });

  it("propagates the error when the function throws", async () => {
    await expect(withSandboxSlot(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  it("releases the slot after success (next call admitted)", async () => {
    await withSandboxSlot(async () => "first");
    const r2 = await withSandboxSlot(async () => "second");
    expect(r2).toBe("second");
  });

  it("releases the slot even when the function throws", async () => {
    await expect(withSandboxSlot(async () => { throw new Error("x"); })).rejects.toThrow();
    // Slot must be free now
    const r2 = await withSandboxSlot(async () => "after");
    expect(r2).toBe("after");
  });
});
