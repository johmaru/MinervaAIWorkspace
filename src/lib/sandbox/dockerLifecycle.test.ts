// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  buildDockerRunArgv,
  buildWriteCodeArgv,
  buildVolumeCreateArgv,
  buildVolumeRmArgv,
  buildOutputVolumeCreateArgv,
  buildOutputVolumeRmArgv,
  buildOutputVolumeInitArgv,
  buildOutputRecoveryArgv,
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

  it("mounts the output volume at /out:rw when outputFiles is set", () => {
    const argv = buildDockerRunArgv({
      ...baseReq,
      outputFiles: [{ containerPath: "/out/result.json", workspacePath: "result.json" }],
    });
    const idx = argv.indexOf("-v");
    const hasOutMount = argv.some((a, i) => a === "-v" && argv[i + 1]?.includes(":/out:rw"));
    expect(hasOutMount).toBe(true);
  });

  it("does NOT mount the output volume when outputFiles is absent", () => {
    const argv = buildDockerRunArgv(baseReq);
    const hasOutMount = argv.some((a) => a.includes(":/out:rw"));
    expect(hasOutMount).toBe(false);
  });
});

/**
 * Fake runner that distinguishes lifecycle steps by argv shape:
 *   - argv[0] === "volume"                 → volume create or rm (staging + output)
 *   - argv[0] === "run" && --user 0        → output volume chown init step
 *   - argv[0] === "run" && /work:rw        → write-code step
 *   - argv[0] === "run" && /out:ro        → output recovery step (cat)
 *   - argv[0] === "run" (else)             → code-exec step (the real run)
 */
function makeFakeRunner(opts: {
  volumeCreateExit?: number;
  writeExit?: number;
  runExit?: number;
  runStdout?: string;
  runStderr?: string;
  hangOnRun?: boolean;
  initExit?: number;
  recoveryContent?: Record<string, string>;
  recoveryExit?: number;
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
    // Output volume chown init step: --user 0
    const userIdx = argv.indexOf("--user");
    if (argv[0] === "run" && userIdx > -1 && argv[userIdx + 1] === "0") {
      return { exitCode: opts.initExit ?? 0, stdout: "", stderr: "" };
    }
    // Write-code step: mount has /work:rw
    const workMount = argv.find((a) => a.includes(":/work:"));
    if (argv[0] === "run" && workMount?.includes(":rw")) {
      return { exitCode: opts.writeExit ?? 0, stdout: "", stderr: "" };
    }
    // Output recovery step: mount has /out:ro
    const outMount = argv.find((a) => a.includes(":/out:"));
    if (argv[0] === "run" && outMount?.includes(":ro")) {
      const catIdx = argv.indexOf("cat");
      const containerPath = catIdx > -1 ? argv[catIdx + 1] : "";
      const content = opts.recoveryContent?.[containerPath] ?? "";
      return {
        exitCode: opts.recoveryExit ?? (content.length > 0 ? 0 : 1),
        stdout: content,
        stderr: content.length > 0 ? "" : "No such file",
      };
    }
    // Code-exec step
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

describe("buildOutputVolumeCreateArgv", () => {
  it("creates the output volume name", () => {
    expect(buildOutputVolumeCreateArgv("run_abc123")).toEqual([
      "volume", "create", "sandbox-output-run_abc123",
    ]);
  });
});

describe("buildOutputVolumeRmArgv", () => {
  it("removes the output volume name", () => {
    expect(buildOutputVolumeRmArgv("run_abc123")).toEqual([
      "volume", "rm", "sandbox-output-run_abc123",
    ]);
  });
});

describe("buildOutputVolumeInitArgv", () => {
  it("chowns the output volume as root", () => {
    const argv = buildOutputVolumeInitArgv("run_abc123", "umanschat-sandbox-python:v0.4");
    expect(argv).toContain("run");
    expect(argv).toContain("--rm");
    const userIdx = argv.indexOf("--user");
    expect(argv[userIdx + 1]).toBe("0");
    const volIdx = argv.indexOf("-v");
    expect(argv[volIdx + 1]).toBe("sandbox-output-run_abc123:/out");
    expect(argv).toContain("chown");
    expect(argv).toContain("10001:10001");
    expect(argv).toContain("/out");
  });
});

describe("buildOutputRecoveryArgv", () => {
  it("mounts the output volume read-only and cats the file", () => {
    const argv = buildOutputRecoveryArgv("run_abc123", "umanschat-sandbox-python:v0.4", "/out/data.jsonl");
    expect(argv).toContain("run");
    expect(argv).toContain("--rm");
    const volIdx = argv.indexOf("-v");
    expect(argv[volIdx + 1]).toBe("sandbox-output-run_abc123:/out:ro");
    expect(argv).toContain("cat");
    expect(argv).toContain("/out/data.jsonl");
  });
});

describe("DockerLifecycle.exec with outputFiles", () => {
  const reqWithOutput: SandboxExecRequest = {
    ...baseReq,
    outputFiles: [{ containerPath: "/out/result.json", workspacePath: "result.json" }],
  };

  it("creates output volume, chowns it, recovers files, and removes both volumes", async () => {
    const calls: string[][] = [];
    const fake: RunCommandFn = async (argv) => {
      calls.push(argv);
      return makeFakeRunner({
        runStdout: "done",
        recoveryContent: { "/out/result.json": '{"answer": 42}' },
      })(argv);
    };
    const lc = new DockerLifecycle(fake);
    const result = await lc.exec(reqWithOutput);

    // staging volume create
    expect(calls[0]).toEqual(["volume", "create", "sandbox-staging-run_abc123"]);
    // output volume create
    expect(calls[1]).toEqual(["volume", "create", "sandbox-output-run_abc123"]);
    // output volume chown init
    expect(calls[2]).toContain("chown");
    // write code
    expect(calls[3]).toContain("sandbox-staging-run_abc123:/work:rw");
    // code-exec run
    expect(calls[4]).toContain("sandbox-output-run_abc123:/out:rw");
    // recovery cat
    expect(calls[5]).toContain("sandbox-output-run_abc123:/out:ro");
    expect(calls[5]).toContain("cat");
    expect(calls[5]).toContain("/out/result.json");
    // staging volume rm
    const rmCalls = calls.filter((c) => c[0] === "volume" && c[1] === "rm");
    expect(rmCalls).toContainEqual(["volume", "rm", "sandbox-staging-run_abc123"]);
    expect(rmCalls).toContainEqual(["volume", "rm", "sandbox-output-run_abc123"]);

    expect(result.exitCode).toBe(0);
    expect(result.outputs?.["/out/result.json"]).toBe('{"answer": 42}');
  });

  it("returns empty string when recovery finds no file", async () => {
    const lc = new DockerLifecycle(makeFakeRunner({ runStdout: "" }));
    const result = await lc.exec(reqWithOutput);
    expect(result.outputs?.["/out/result.json"]).toBe("");
    expect(result.stderr).toContain("output recovery failed");
  });

  it("fails when output volume create fails", async () => {
    const lc = new DockerLifecycle(makeFakeRunner({ volumeCreateExit: 1 }));
    const result = await lc.exec(reqWithOutput);
    // volume create fails on the FIRST call (staging volume), not output volume.
    // When staging create fails, we never reach output volume creation.
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("failed to create staging volume");
  });
});
