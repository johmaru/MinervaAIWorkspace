// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock getUserDataRoot to return a temp dir (avoids mkdirSync failures)
vi.mock("@/lib/user-data", () => ({
  getUserDataRoot: () => tmpdir(),
}));

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mockSpawn };
});

import { runWorkspaceCommand } from "./workspace";

const TEST_USER = "test-user";

function createMockChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  return child;
}

describe("runWorkspaceCommand", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("calls spawn with shell: false", async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = runWorkspaceCommand("echo hello", TEST_USER);
    mockChild.stdout?.emit("data", Buffer.from("hello"));
    mockChild.emit("close", 0);
    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const callArgs = mockSpawn.mock.calls[0];
    expect(callArgs[2]).toMatchObject({ shell: false });
  });

  it("passes only safe env vars (no LLM_API_KEY, AUTH_SECRET)", async () => {
    process.env.LLM_API_KEY = "sk-secret-test-123";
    process.env.AUTH_SECRET = "secret-auth-test-456";

    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = runWorkspaceCommand("echo test", TEST_USER);
    mockChild.stdout?.emit("data", Buffer.from("test"));
    mockChild.emit("close", 0);
    await promise;

    const callArgs = mockSpawn.mock.calls[0];
    const env = callArgs[2]?.env as Record<string, string>;

    expect(env).toHaveProperty("PATH");
    expect(env).toHaveProperty("HOME");
    expect(env).not.toHaveProperty("LLM_API_KEY");
    expect(env).not.toHaveProperty("AUTH_SECRET");

    delete process.env.LLM_API_KEY;
    delete process.env.AUTH_SECRET;
  });

  it("blocks disallowed binary (rm)", async () => {
    const result = await runWorkspaceCommand("rm -rf /", TEST_USER);
    expect(result).toContain("Blocked:");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("blocks disallowed binary (node -e)", async () => {
    const result = await runWorkspaceCommand('node -e "require(\'child_process\').execSync(\'rm -rf /\')"', TEST_USER);
    expect(result).toContain("Blocked:");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("blocks disallowed binary (curl)", async () => {
    const result = await runWorkspaceCommand("curl http://evil.com", TEST_USER);
    expect(result).toContain("Blocked:");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("blocks disallowed binary (python -c)", async () => {
    const result = await runWorkspaceCommand("python -c 'import os; os.system(\"rm -rf /\")'", TEST_USER);
    expect(result).toContain("Blocked:");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("blocks find -exec", async () => {
    const result = await runWorkspaceCommand("find . -exec rm -rf / ;", TEST_USER);
    expect(result).toContain("Blocked:");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("allows and executes git status", async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = runWorkspaceCommand("git status", TEST_USER);
    mockChild.stdout?.emit("data", Buffer.from("On branch main"));
    mockChild.emit("close", 0);
    const result = await promise;

    expect(result).toContain("Exit code: 0");
    expect(result).toContain("On branch main");
    const callArgs = mockSpawn.mock.calls[0];
    expect(callArgs[0]).toBe("git");
    expect(callArgs[1]).toEqual(["status"]);
  });

  it("allows and executes ls -la", async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = runWorkspaceCommand("ls -la", TEST_USER);
    mockChild.stdout?.emit("data", Buffer.from("total 0"));
    mockChild.emit("close", 0);
    const result = await promise;

    expect(result).toContain("total 0");
    const callArgs = mockSpawn.mock.calls[0];
    expect(callArgs[0]).toBe("ls");
    expect(callArgs[1]).toEqual(["-la"]);
  });

  it("returns error for empty command", async () => {
    const result = await runWorkspaceCommand("", TEST_USER);
    expect(result).toContain("Error: empty command");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("handles command execution error", async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const promise = runWorkspaceCommand("git status", TEST_USER);
    mockChild.emit("error", new Error("spawn ENOENT"));
    const result = await promise;

    expect(result).toContain("Command execution error");
  });

  it("truncates large output", async () => {
    const mockChild = createMockChild();
    mockSpawn.mockReturnValue(mockChild);

    const largeOutput = "x".repeat(2 * 1024 * 1024); // 2MB
    const promise = runWorkspaceCommand("cat bigfile", TEST_USER);
    mockChild.stdout?.emit("data", Buffer.from(largeOutput));
    mockChild.emit("close", 0);
    const result = await promise;

    expect(result).toContain("truncated");
  });
});
