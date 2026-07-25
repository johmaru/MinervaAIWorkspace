// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

// Mock getUserDataRoot to return a temp dir (avoids mkdirSync failures)
vi.mock("@/lib/user-data", () => ({
  getUserDataRoot: () => tmpdir(),
}));

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mockSpawn };
});

import {
  runWorkspaceCommand,
  globToRegExp,
  listWorkspaceDirectory,
  searchWorkspaceFiles,
  grepWorkspaceContent,
  getWorkspaceRoot,
} from "./workspace";

const TEST_USER = "test-user";
const EXPLORE_USER = "ws-explore-user";

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

describe("globToRegExp", () => {
  it("matches **/*.json and basename *.ts", () => {
    const jsonRe = globToRegExp("**/*.json");
    expect(jsonRe.test("data/Story.json")).toBe(true);
    expect(jsonRe.test("Story.json")).toBe(true);
    expect(jsonRe.test("a/b/c.ts")).toBe(false);

    const tsRe = globToRegExp("*.ts");
    expect(tsRe.test("main.ts")).toBe(true);
    expect(tsRe.test("src/main.ts")).toBe(false);
  });

  it("matches nested Story* patterns", () => {
    const re = globToRegExp("**/Story*.json");
    expect(re.test("Story.json")).toBe(true);
    expect(re.test("app/data/StoryPart.json")).toBe(true);
    expect(re.test("Story.md")).toBe(false);
  });
});

describe("workspace exploration tools", () => {
  let prevHostPath: string | undefined;
  let root: string;

  beforeEach(() => {
    prevHostPath = process.env.WORKSPACE_HOST_PATH;
    delete process.env.WORKSPACE_HOST_PATH;
    root = getWorkspaceRoot(EXPLORE_USER);
    // fixture: nested project-like tree
    mkdirSync(join(root, "src", "components", "story"), { recursive: true });
    mkdirSync(join(root, "data"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "src", "components", "story", "StoryCard.tsx"), 'export const id = "st-card-ai-1";\nconst text = "hello";\n');
    writeFileSync(join(root, "data", "Story.json"), '[{"id":"st-card-ai-1","name":"Title","description":""}]\n');
    writeFileSync(join(root, "data", "StoryPart.json"), '[{"id":"st-part-main-01","assetId":"x"}]\n');
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), 'module.exports = 1;\n');
    writeFileSync(join(root, "README.md"), "# fixture\n");
  });

  afterEach(() => {
    if (prevHostPath === undefined) delete process.env.WORKSPACE_HOST_PATH;
    else process.env.WORKSPACE_HOST_PATH = prevHostPath;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows file locks
    }
  });

  it("list_directory depth=1 is flat and tags empty dirs", async () => {
    const listed = await listWorkspaceDirectory(".", EXPLORE_USER);
    expect(listed).toContain("[DIR] src");
    expect(listed).toContain("[DIR] data");
    expect(listed).not.toContain("StoryCard.tsx");

    mkdirSync(join(root, "empty-dir"), { recursive: true });
    const empty = await listWorkspaceDirectory("empty-dir", EXPLORE_USER);
    expect(empty).toContain("[LIST empty]");
  });

  it("list_directory depth>1 returns a shallow tree", async () => {
    // StoryCard lives at src/components/story/StoryCard.tsx → needs depth 4
    const listed = await listWorkspaceDirectory(".", EXPLORE_USER, { depth: 4 });
    expect(listed).toContain("src/components");
    expect(listed).toContain("StoryCard.tsx");
    // depth 2 stops before story children
    const shallow = await listWorkspaceDirectory(".", EXPLORE_USER, { depth: 2 });
    expect(shallow).toContain("src/components");
    expect(shallow).not.toContain("StoryCard.tsx");
  });

  it("search_files finds by glob and skips node_modules", async () => {
    const found = await searchWorkspaceFiles("**/*.json", EXPLORE_USER);
    expect(found).toContain("data/Story.json");
    expect(found).toContain("data/StoryPart.json");
    expect(found).not.toContain("node_modules");

    const none = await searchWorkspaceFiles("**/*.py", EXPLORE_USER);
    expect(none).toContain("[SEARCH empty]");
  });

  it("grep_content finds field names and reports empty honestly", async () => {
    const hits = await grepWorkspaceContent("st-card-ai", EXPLORE_USER, { glob: "*.{ts,tsx,json}" });
    expect(hits).toMatch(/StoryCard\.tsx:\d+:/);
    expect(hits).toMatch(/Story\.json:\d+:/);

    const none = await grepWorkspaceContent("this-string-does-not-exist-xyz", EXPLORE_USER);
    expect(none).toContain("[GREP empty]");
  });

  it("grep_content rejects invalid regex", async () => {
    const result = await grepWorkspaceContent("([unclosed", EXPLORE_USER);
    expect(result).toContain("[GREP error]");
  });
});
