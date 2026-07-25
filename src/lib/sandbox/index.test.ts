// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock node:os: keep all real exports, only override freemem/totalmem so
// admission control sees plentiful memory. Mocking wholesale breaks tmpdir.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    freemem: vi.fn(() => 8 * 1024 ** 3),
    totalmem: vi.fn(() => 16 * 1024 ** 3),
  };
});

// Mock dockerDetect: injectable availability + image presence + runner.
// All sandbox-detect behaviour is driven by `sandboxState` so tests can flip
// flags without re-mocking between cases.
const sandboxState = vi.hoisted(() => ({
  dockerAvailable: true,
  imagePresent: true,
  forcedOff: false,
  // The result of the actual code-run step (step 3 of lifecycle).
  runResult: { exitCode: 0, stdout: "hi\n", stderr: "" } as {
    exitCode: number; stdout: string; stderr: string;
  },
  notFound: false,
  shouldHang: false,
  capturedArgv: null as string[] | null,
  // Track all docker calls for cleanup verification.
  volumeCreated: false,
  volumeRemoved: false,
}));
vi.mock("./dockerDetect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dockerDetect")>();
  return {
    ...actual,
    isSandboxForcedOff: () => sandboxState.forcedOff,
    isDockerAvailable: async () => sandboxState.dockerAvailable,
    isSandboxImagePresent: async () => sandboxState.imagePresent,
    shouldExposeSandboxTool: async () => {
      if (sandboxState.forcedOff) return false;
      if (sandboxState.dockerAvailable && sandboxState.imagePresent) return true;
      return false;
    },
    getSandboxImage: () => "umanschat-sandbox-python:v0.4",
    defaultRunCommand: async (argv: string[]) => {
      // Track volume create/rm for cleanup tests.
      if (argv[0] === "volume" && argv[1] === "create") {
        sandboxState.volumeCreated = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "volume" && argv[1] === "rm") {
        sandboxState.volumeRemoved = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // Write-code step (volume mounted rw).
      if (argv[0] === "run" && argv.some(a => a.includes(":/work:rw"))) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // The actual code run — capture argv, return result or hang.
      sandboxState.capturedArgv = argv;
      if (sandboxState.shouldHang) {
        return new Promise(() => { /* never resolves */ });
      }
      const r = sandboxState.runResult;
      return sandboxState.notFound
        ? { exitCode: -1, stdout: r.stdout, stderr: r.stderr, notFound: true }
        : { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
  };
});

import { runSandbox, getSandboxToolsForRequest } from "./index";
import { _resetForTesting as resetAdmission } from "./admission";

beforeEach(() => {
  sandboxState.dockerAvailable = true;
  sandboxState.imagePresent = true;
  sandboxState.forcedOff = false;
  sandboxState.runResult = { exitCode: 0, stdout: "hi\n", stderr: "" };
  sandboxState.notFound = false;
  sandboxState.shouldHang = false;
  sandboxState.capturedArgv = null;
  sandboxState.volumeCreated = false;
  sandboxState.volumeRemoved = false;
  resetAdmission();
  vi.stubEnv("SANDBOX_ENABLED", "auto");
  vi.stubEnv("SANDBOX_DEFAULT_TIMEOUT_SEC", "30");
  vi.stubEnv("SANDBOX_STDOUT_MAX_BYTES", "4096");
  vi.stubEnv("SANDBOX_MIN_FREE_MEM_PERCENT", "15");
  vi.stubEnv("SANDBOX_MAX_CONCURRENT", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runSandbox — policy gate failures (no Docker touched)", () => {
  it("rejects invalid args with invalid_args", async () => {
    const r = await runSandbox(null, "test-user-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_args");
    expect(sandboxState.capturedArgv).toBeNull();
  });

  it("rejects tier_forbidden preset (file_inspect)", async () => {
    const r = await runSandbox({ preset: "file_inspect" }, "test-user-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("tier_forbidden");
  });

  it("rejects inputRef with tier_forbidden", async () => {
    const r = await runSandbox({ preset: "code_run", code: "print(1)", inputRef: "x.exe" }, "test-user-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("tier_forbidden");
  });

  it("rejects unsupported language with invalid_args", async () => {
    const r = await runSandbox({ preset: "code_run", language: "rust", code: "fn main(){}" }, "test-user-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_args");
  });
});

describe("runSandbox — feature gate / Docker failures", () => {
  it("returns docker_unavailable when SANDBOX_ENABLED=false", async () => {
    sandboxState.forcedOff = true;
    const r = await runSandbox({ preset: "code_run", code: "print(1)" }, "test-user-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("docker_unavailable");
  });

  it("returns docker_unavailable when daemon not reachable", async () => {
    sandboxState.dockerAvailable = false;
    const r = await runSandbox({ preset: "code_run", code: "print(1)" }, "test-user-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("docker_unavailable");
  });

  it("returns image_missing when image not present", async () => {
    sandboxState.imagePresent = false;
    const r = await runSandbox({ preset: "code_run", code: "print(1)" }, "test-user-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("image_missing");
  });
});

describe("runSandbox — admission failures", () => {
  it("returns insufficient_host_memory when below threshold", async () => {
    const os = await import("node:os");
    vi.mocked(os.freemem).mockReturnValue(0);
    vi.mocked(os.totalmem).mockReturnValue(16 * 1024 ** 3);
    const r = await runSandbox({ preset: "code_run", code: "print(1)" }, "test-user-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("insufficient_host_memory");
    vi.mocked(os.freemem).mockReturnValue(8 * 1024 ** 3);
  });
});

describe("runSandbox — success path", () => {
  it("runs python code and returns sanitized stdout", async () => {
    sandboxState.runResult = { exitCode: 0, stdout: "42\n", stderr: "" };
    const r = await runSandbox({ preset: "code_run", language: "python", code: "print(42)" }, "test-user-id");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset).toBe("code_run");
      expect(r.tier).toBe(1);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("42\n");
      expect(r.stderr).toBe("");
      expect(r.stdoutTruncated).toBe(false);
      expect(typeof r.durationMs).toBe("number");
    }
    expect(sandboxState.capturedArgv).not.toBeNull();
    const argv = sandboxState.capturedArgv!;
    expect(argv).toContain("python");
    expect(argv).toContain("main.py");
  });

  it("runs javascript code and returns sanitized stdout", async () => {
    sandboxState.runResult = { exitCode: 0, stdout: "99\n", stderr: "" };
    const r = await runSandbox({ preset: "code_run", language: "javascript", code: "console.log(99)" }, "test-user-id");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stdout).toBe("99\n");
    expect(sandboxState.capturedArgv).toContain("node");
    expect(sandboxState.capturedArgv).toContain("main.js");
  });

  it("returns non-zero exit code on program error", async () => {
    sandboxState.runResult = {
      exitCode: 1,
      stdout: "",
      stderr: "Traceback (most recent call last):\n  NameError: name 'x' is not defined",
    };
    const r = await runSandbox({ preset: "code_run", code: "print(x)" }, "test-user-id");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("NameError");
    }
  });

  it("truncates stdout exceeding the cap", async () => {
    vi.stubEnv("SANDBOX_STDOUT_MAX_BYTES", "10");
    sandboxState.runResult = { exitCode: 0, stdout: "0123456789ABCDEF", stderr: "" };
    const r = await runSandbox({ preset: "code_run", code: "print('long')" }, "test-user-id");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stdout).toBe("0123456789");
      expect(r.stdoutTruncated).toBe(true);
    }
  });

  it("strips control chars from stdout", async () => {
    sandboxState.runResult = { exitCode: 0, stdout: "ok\x00done", stderr: "" };
    const r = await runSandbox({ preset: "code_run", code: "print('x')" }, "test-user-id");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stdout).toBe("okdone");
  });
});

describe("runSandbox — timeout", () => {
  it("returns timeout error code when container times out", async () => {
    vi.stubEnv("SANDBOX_DEFAULT_TIMEOUT_SEC", "1");
    sandboxState.shouldHang = true;
    const r = await runSandbox({ preset: "code_run", code: "while True: pass" }, "test-user-id");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("timeout");
  });
});

describe("runSandbox — volume cleanup", () => {
  it("creates and removes the staging volume on success", async () => {
    sandboxState.runResult = { exitCode: 0, stdout: "ok", stderr: "" };
    await runSandbox({ preset: "code_run", code: "print(1)" }, "test-user-id");
    expect(sandboxState.volumeCreated).toBe(true);
    expect(sandboxState.volumeRemoved).toBe(true);
  });

  it("removes the volume even on container failure", async () => {
    sandboxState.runResult = { exitCode: 1, stdout: "", stderr: "error" };
    await runSandbox({ preset: "code_run", code: "print(x)" }, "test-user-id");
    expect(sandboxState.volumeCreated).toBe(true);
    expect(sandboxState.volumeRemoved).toBe(true);
  });

  it("removes the volume even on timeout", async () => {
    vi.stubEnv("SANDBOX_DEFAULT_TIMEOUT_SEC", "1");
    sandboxState.shouldHang = true;
    await runSandbox({ preset: "code_run", code: "while True: pass" }, "test-user-id");
    expect(sandboxState.volumeCreated).toBe(true);
    expect(sandboxState.volumeRemoved).toBe(true);
  });
});

describe("getSandboxToolsForRequest", () => {
  it("returns the sandbox_run tool definition when exposed", async () => {
    vi.stubEnv("SANDBOX_ENABLED", "auto");
    sandboxState.dockerAvailable = true;
    sandboxState.imagePresent = true;
    const tools = await getSandboxToolsForRequest();
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("sandbox_run");
  });

  it("returns [] when forced off", async () => {
    sandboxState.forcedOff = true;
    const tools = await getSandboxToolsForRequest();
    expect(tools).toEqual([]);
  });

  it("returns [] when docker unavailable", async () => {
    sandboxState.dockerAvailable = false;
    const tools = await getSandboxToolsForRequest();
    expect(tools).toEqual([]);
  });

  it("returns [] when image missing", async () => {
    sandboxState.imagePresent = false;
    const tools = await getSandboxToolsForRequest();
    expect(tools).toEqual([]);
  });
});
