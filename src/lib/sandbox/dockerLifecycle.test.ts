// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildDockerRunArgv, DockerLifecycle } from "./dockerLifecycle";
import type { SandboxExecRequest } from "./lifecycle";
import type { RunCommandFn } from "./dockerDetect";

const baseReq: SandboxExecRequest = {
  runId: "run_abc123",
  image: "umanschat-sandbox-python:v0.4",
  language: "python",
  hostStagingDir: "/tmp/sandbox-staging/run_abc123",
  timeoutSec: 30,
  memLimitMb: 256,
};

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

  it("bind-mounts staging dir read-only at /work", () => {
    const argv = buildDockerRunArgv(baseReq);
    const idx = argv.indexOf("-v");
    expect(argv[idx + 1]).toBe("/tmp/sandbox-staging/run_abc123:/work:ro");
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

describe("DockerLifecycle.exec", () => {
  it("invokes runCommand with the built argv", async () => {
    let captured: string[] | null = null;
    const fake: RunCommandFn = async (argv) => {
      captured = argv;
      return { exitCode: 0, stdout: "hi\n", stderr: "" };
    };
    const lc = new DockerLifecycle(fake);
    const result = await lc.exec(baseReq);
    expect(captured).not.toBeNull();
    expect(captured).toEqual(buildDockerRunArgv(baseReq));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.timedOut).toBe(false);
  });

  it("passes timeoutMs derived from timeoutSec", async () => {
    let capturedTimeout: number | undefined;
    const fake: RunCommandFn = async (_argv, opts) => {
      capturedTimeout = opts?.timeoutMs;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const lc = new DockerLifecycle(fake);
    await lc.exec({ ...baseReq, timeoutSec: 45 });
    expect(capturedTimeout).toBe(45_000);
  });

  it("returns timedOut=true when the run exceeds the timeout", async () => {
    // Runner that never resolves → the race's timeout branch wins.
    const fake: RunCommandFn = () => new Promise(() => { /* never resolves */ });
    const lc = new DockerLifecycle(fake);
    const result = await lc.exec({ ...baseReq, timeoutSec: 0 });
    // timeoutSec 0 → timeoutMs 0 → setTimeout fires immediately.
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/timed out/);
  });

  it("surfaces a non-zero exit code on container failure", async () => {
    const fake: RunCommandFn = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "python: can't open file 'main.py': [Errno 2] No such file or directory",
    });
    const lc = new DockerLifecycle(fake);
    const result = await lc.exec(baseReq);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
    expect(result.timedOut).toBe(false);
  });

  it("surfaces notFound as exitCode -1 with stderr", async () => {
    const fake: RunCommandFn = async () => ({
      exitCode: -1,
      stdout: "",
      stderr: "docker: command not found",
      notFound: true,
    });
    const lc = new DockerLifecycle(fake);
    const result = await lc.exec(baseReq);
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
  });
});
