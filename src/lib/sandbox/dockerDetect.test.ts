// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  _setRunCommand,
  _resetRunCommand,
  isSandboxForcedOff,
  isSandboxForcedOn,
  isDockerAvailable,
  isSandboxImagePresent,
  shouldExposeSandboxTool,
  getSandboxImage,
  type CommandResult,
  type RunCommandFn,
} from "./dockerDetect";

describe("isSandboxForcedOff / isSandboxForcedOn", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forced off when SANDBOX_ENABLED=false", () => {
    vi.stubEnv("SANDBOX_ENABLED", "false");
    expect(isSandboxForcedOff()).toBe(true);
    expect(isSandboxForcedOn()).toBe(false);
  });

  it("forced on when SANDBOX_ENABLED=true", () => {
    vi.stubEnv("SANDBOX_ENABLED", "true");
    expect(isSandboxForcedOff()).toBe(false);
    expect(isSandboxForcedOn()).toBe(true);
  });

  it("neither when unset (auto)", () => {
    vi.stubEnv("SANDBOX_ENABLED", "");
    expect(isSandboxForcedOff()).toBe(false);
    expect(isSandboxForcedOn()).toBe(false);
  });

  it("neither when auto", () => {
    vi.stubEnv("SANDBOX_ENABLED", "auto");
    expect(isSandboxForcedOff()).toBe(false);
    expect(isSandboxForcedOn()).toBe(false);
  });
});

describe("getSandboxImage", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns default tag when env unset", () => {
    vi.stubEnv("SANDBOX_IMAGE", "");
    expect(getSandboxImage()).toBe("umanschat-sandbox-python:v0.4");
  });

  it("returns env override when set", () => {
    vi.stubEnv("SANDBOX_IMAGE", "my-registry/sandbox:v1");
    expect(getSandboxImage()).toBe("my-registry/sandbox:v1");
  });
});

describe("isDockerAvailable", () => {
  beforeEach(() => _resetRunCommand());
  afterEach(() => _resetRunCommand());

  it("returns true when docker info exits 0", async () => {
    _setRunCommand(async () => ({ exitCode: 0, stdout: "24.0.7", stderr: "" }));
    expect(await isDockerAvailable()).toBe(true);
  });

  it("returns false when docker info exits non-zero", async () => {
    _setRunCommand(async () => ({ exitCode: 1, stdout: "", stderr: "Cannot connect" }));
    expect(await isDockerAvailable()).toBe(false);
  });

  it("returns false when docker binary not found (ENOENT)", async () => {
    _setRunCommand(async () => ({ exitCode: -1, stdout: "", stderr: "", notFound: true }));
    expect(await isDockerAvailable()).toBe(false);
  });

  it("returns false when runner throws", async () => {
    _setRunCommand(async () => { throw new Error("boom"); });
    expect(await isDockerAvailable()).toBe(false);
  });
});

describe("isSandboxImagePresent", () => {
  beforeEach(() => _resetRunCommand());
  afterEach(() => _resetRunCommand());

  it("returns true when docker image inspect exits 0", async () => {
    _setRunCommand(async () => ({ exitCode: 0, stdout: "[]", stderr: "" }));
    expect(await isSandboxImagePresent("umanschat-sandbox-python:v0.4")).toBe(true);
  });

  it("returns false when image absent (exit 1)", async () => {
    _setRunCommand(async () => ({ exitCode: 1, stdout: "", stderr: "No such image" }));
    expect(await isSandboxImagePresent("missing:v0.4")).toBe(false);
  });
});

describe("shouldExposeSandboxTool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetRunCommand();
  });

  it("returns false when forced off", async () => {
    vi.stubEnv("SANDBOX_ENABLED", "false");
    const fake: RunCommandFn = vi.fn();
    _setRunCommand(fake);
    expect(await shouldExposeSandboxTool()).toBe(false);
    expect(fake).not.toHaveBeenCalled();
  });

  it("returns true when forced on, without probing docker", async () => {
    vi.stubEnv("SANDBOX_ENABLED", "true");
    const fake: RunCommandFn = vi.fn();
    _setRunCommand(fake);
    expect(await shouldExposeSandboxTool()).toBe(true);
    expect(fake).not.toHaveBeenCalled();
  });

  it("auto: returns true when docker available + image present", async () => {
    vi.stubEnv("SANDBOX_ENABLED", "auto");
    let call = 0;
    _setRunCommand(async (argv) => {
      call++;
      // First call: docker info (exit 0). Second call: docker image inspect (exit 0).
      if (call === 1) return { exitCode: 0, stdout: "24.0", stderr: "" };
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });
    expect(await shouldExposeSandboxTool()).toBe(true);
  });

  it("auto: returns false when docker unavailable", async () => {
    vi.stubEnv("SANDBOX_ENABLED", "auto");
    _setRunCommand(async () => ({ exitCode: 1, stdout: "", stderr: "no daemon" }));
    expect(await shouldExposeSandboxTool()).toBe(false);
  });

  it("auto: returns false when docker ok but image missing", async () => {
    vi.stubEnv("SANDBOX_ENABLED", "auto");
    let call = 0;
    _setRunCommand(async () => {
      call++;
      if (call === 1) return { exitCode: 0, stdout: "24.0", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "No such image" };
    });
    expect(await shouldExposeSandboxTool()).toBe(false);
  });

  it("auto (default): returns false when env unset and docker unavailable", async () => {
    vi.stubEnv("SANDBOX_ENABLED", "");
    _setRunCommand(async () => ({ exitCode: -1, stdout: "", stderr: "", notFound: true }));
    expect(await shouldExposeSandboxTool()).toBe(false);
  });
});
