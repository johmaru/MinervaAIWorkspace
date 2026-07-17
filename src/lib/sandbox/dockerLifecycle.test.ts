// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  buildDockerRunArgv,
  buildWriteCodeArgv,
  buildVolumeCreateArgv,
  buildVolumeRmArgv,
  DockerLifecycle,
} from "./dockerLifecycle";
import type { SandboxExecRequest } from "./lifecycle";
import type { RunCommandFn } from "./dockerDetect";

const baseReq: SandboxExecRequest = {
  runId: "run_abc123",
  image: "umanschat-sandbox-python:v0.4",
  language: "python",
  code: "print('hello')",
  timeoutSec: 30,
  memLimitMb: 256,
};

describe("buildVolumeCreateArgv", () => {
  it("creates the named volume", () => {
    expect(buildVolumeCreateArgv("run_abc123")).toEqual([
      "volume", "create", "sandbox-staging-run_abc123",
    ]);
  });
});

describe("buildVolumeRmArgv", () => {
  it("removes the named volume", () => {
    expect(buildVolumeRmArgv("run_abc123")).toEqual([
      "volume", "rm", "sandbox-staging-run_abc123",
    ]);
  });
});

describe("buildWriteCodeArgv", () => {
  it("uses the named volume mounted rw and writes to main.py for python", () => {
    const argv = buildWriteCodeArgv(baseReq);
    expect(argv).toContain("run");
    expect(argv).toContain("--rm");
    const volIdx = argv.indexOf("-v");
    expect(argv[volIdx + 1]).toBe("sandbox-staging-run_abc123:/work:rw");
    // The last element is the sh -c command
    const cmd = argv[argv.length - 1];
    expect(cmd).toContain("/work/main.py");
  });

  it("writes to main.js for javascript", () => {
    const argv = buildWriteCodeArgv({ ...baseReq, language: "javascript" });
    const cmd = argv[argv.length - 1];
    expect(cmd).toContain("/work/main.js");
  });
});

describe("buildDockerRunArgv", () => {
  it("includes --rm and container name", () => {
    const argv = buildDockerRunArgv(baseReq);
    expect(argv).toContain("run");
    expect(argv).toContain("--rm");
    const nameIdx = argv.indexOf("--name");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(argv[nameIdx + 1]).toBe("sandbox-run_abc123");
  });

  it("disables networking (--network none)", () => {
    const argv = buildDockerRunArgv(baseReq);
    const idx = argv.indexOf("--network");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("none");
  });

  it("sets memory limit from memLimitMb", () => {
    const argv = buildDockerRunArgv({ ...baseReq, memLimitMb: 512 });
    const idx = argv.indexOf("--memory");
    expect(argv[idx + 1]).toBe("512m");
  });

  it("defaults memory to 256m when memLimitMb omitted", () => {
    const { memLimitMb: _omit, ...reqWithoutMem } = baseReq;
    void _omit;
    const argv = buildDockerRunArgv(reqWithoutMem);
    const idx = argv.indexOf("--memory");
    expect(argv[idx + 1]).toBe("256m");
  });

  it("sets pids-limit 64", () => {
    const argv = buildDockerRunArgv(baseReq);
    const idx = argv.indexOf("--pids-limit");
    expect(argv[idx + 1]).toBe("64");
  });

  it("sets root filesystem read-only", () => {
    const argv = buildDockerRunArgv(baseReq);
    expect(argv).toContain("--read-only");
  });

  it("mounts a tmpfs at /tmp with noexec,nosuid,size=64m", () => {
    const argv = buildDockerRunArgv(baseReq);
    const idx = argv.indexOf("--tmpfs");
    expect(argv[idx + 1]).toBe("/tmp:rw,noexec,nosuid,size=64m");
  });

  it("mounts the named volume read-only at /work", () => {
    const argv = buildDockerRunArgv(baseReq);
    const idx = argv.indexOf("-v");
    expect(argv[idx + 1]).toBe("sandbox-staging-run_abc123:/work:ro");
  });

  it("sets working dir to /work", () => {
    const argv = buildDockerRunArgv(baseReq);
    const idx = argv.indexOf("-w");
    expect(argv[idx + 1]).toBe("/work");
  });

  it("appends python main.py for python", () => {
    const argv = buildDockerRunArgv({ ...baseReq, language: "python" });
    const imgIdx = argv.indexOf("umanschat-sandbox-python:v0.4");
    expect(argv.slice(imgIdx + 1)).toEqual(["python", "main.py"]);
  });

  it("appends node main.js for javascript", () => {
    const argv = buildDockerRunArgv({ ...baseReq, language: "javascript" });
    const imgIdx = argv.indexOf("umanschat-sandbox-python:v0.4");
    expect(argv.slice(imgIdx + 1)).toEqual(["node", "main.js"]);
  });

  it("uses the provided image tag", () => {
    const argv = buildDockerRunArgv({ ...baseReq, image: "custom:v2" });
    expect(argv).toContain("custom:v2");
  });
});

/**
 * Fake runner that distinguishes the 4 lifecycle steps by argv shape:
 *   - argv[0] === "volume"  → volume create or rm
 *   - argv[0] === "run" && mount contains ":rw" → write-code step
 *   - argv[0] === "run" && mount contains ":ro" → code-exec step (the real run)
 */
function makeFakeRunner(opts: {
  volumeCreateExit?: number;
  writeExit?: number;
  runExit?: number;
  runStdout?: string;
  runStderr?: string;
  hangOnRun?: boolean;
}): RunCommandFn {
  return async (argv) => {
    // Volume create / rm
    if (argv[0] === "volume") {
      if (argv[1] === "create") {
        return { exitCode: opts.volumeCreateExit ?? 0, stdout: "", stderr: "" };
      }
      // rm
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    // Write-code step: mount has :rw
    const volMount = argv.find((a) => a.includes(":/work:"));
    if (argv[0] === "run" && volMount?.includes(":rw")) {
      return { exitCode: opts.writeExit ?? 0, stdout: "", stderr: "" };
    }
    // Code-exec step: mount has :ro
    if (opts.hangOnRun) {
      return new Promise(() => { /* never resolves */ });
    }
    return {
      exitCode: opts.runExit ?? 0,
      stdout: opts.runStdout ?? "",
      stderr: opts.runStderr ?? "",
    };
  };
}

describe("DockerLifecycle.exec", () => {
  it("creates volume, writes code, runs container, removes volume", async () => {
    const calls: string[][] = [];
    const fake: RunCommandFn = async (argv) => {
      calls.push(argv);
      return makeFakeRunner({ runStdout: "" })(argv);
    };
    const lc = new DockerLifecycle(fake);
    const result = await lc.exec(baseReq);

    // Step 1: volume create
    expect(calls[0]).toEqual(["volume", "create", "sandbox-staging-run_abc123"]);
    // Step 2: write code (volume mounted rw)
    expect(calls[1]).toContain("sandbox-staging-run_abc123:/work:rw");
    // Step 3: docker run (volume mounted ro)
    expect(calls[2]).toContain("sandbox-staging-run_abc123:/work:ro");
    // Step 4: volume rm
    expect(calls[3]).toEqual(["volume", "rm", "sandbox-staging-run_abc123"]);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("returns failure when volume create fails", async () => {
    const lc = new DockerLifecycle(makeFakeRunner({ volumeCreateExit: 1 }));
    const result = await lc.exec(baseReq);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("failed to create staging volume");
    expect(result.timedOut).toBe(false);
  });

  it("returns failure when code write fails", async () => {
    const lc = new DockerLifecycle(makeFakeRunner({ writeExit: 1 }));
    const result = await lc.exec(baseReq);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("failed to write code");
  });

  it("still removes the volume even when code write fails", async () => {
    const calls: string[][] = [];
    const fake: RunCommandFn = async (argv) => {
      calls.push(argv);
      return makeFakeRunner({ writeExit: 1 })(argv);
    };
    const lc = new DockerLifecycle(fake);
    await lc.exec(baseReq);
    const last = calls[calls.length - 1];
    expect(last).toEqual(["volume", "rm", "sandbox-staging-run_abc123"]);
  });

  it("returns timedOut=true when the run exceeds the timeout", async () => {
    const lc = new DockerLifecycle(makeFakeRunner({ hangOnRun: true }));
    const result = await lc.exec({ ...baseReq, timeoutSec: 0 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/timed out/);
  });

  it("still removes the volume after timeout", async () => {
    const calls: string[][] = [];
    const fake: RunCommandFn = async (argv) => {
      calls.push(argv);
      return makeFakeRunner({ hangOnRun: true })(argv);
    };
    const lc = new DockerLifecycle(fake);
    await lc.exec({ ...baseReq, timeoutSec: 0 });
    const last = calls[calls.length - 1];
    expect(last).toEqual(["volume", "rm", "sandbox-staging-run_abc123"]);
  });

  it("surfaces stdout from the run", async () => {
    const lc = new DockerLifecycle(makeFakeRunner({ runStdout: "hello\n" }));
    const result = await lc.exec(baseReq);
    expect(result.stdout).toBe("hello\n");
  });

  it("surfaces non-zero exit code", async () => {
    const lc = new DockerLifecycle(makeFakeRunner({ runExit: 1, runStderr: "NameError" }));
    const result = await lc.exec(baseReq);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("NameError");
  });
});
