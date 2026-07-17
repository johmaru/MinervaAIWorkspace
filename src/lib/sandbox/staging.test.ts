// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// Mock user-data so staging writes under a temp dir, not real data/.
const tempRoot = mkdtempSync(join(tmpdir(), "sandbox-staging-test-"));
vi.mock("@/lib/user-data", () => ({
  getDataDir: () => tempRoot,
}));

import {
  getSandboxStagingRoot,
  createRunStaging,
  writeRunCode,
  removeRunStaging,
  filenameForLanguage,
} from "./staging";

afterEach(() => {
  // Clean any staging dirs created by tests
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("getSandboxStagingRoot", () => {
  it("returns <dataDir>/sandbox-staging", () => {
    expect(getSandboxStagingRoot()).toBe(join(tempRoot, "sandbox-staging"));
  });
});

describe("createRunStaging", () => {
  it("creates a directory under the staging root", async () => {
    const dir = await createRunStaging("run_abc123");
    expect(dir).toBe(join(tempRoot, "sandbox-staging", "run_abc123"));
    const st = statSync(dir);
    expect(st.isDirectory()).toBe(true);
  });

  it("is idempotent — creating twice does not throw", async () => {
    const dir1 = await createRunStaging("run_idemp");
    const dir2 = await createRunStaging("run_idemp");
    expect(dir1).toBe(dir2);
  });

  it("rejects runId with path separators", async () => {
    await expect(createRunStaging("../escape")).rejects.toThrow("invalid runId");
    await expect(createRunStaging("a/b")).rejects.toThrow("invalid runId");
    await expect(createRunStaging("a\\b")).rejects.toThrow("invalid runId");
  });

  it("rejects runId that is too short", async () => {
    await expect(createRunStaging("ab")).rejects.toThrow("invalid runId");
  });

  it("rejects empty runId", async () => {
    await expect(createRunStaging("")).rejects.toThrow("invalid runId");
  });

  it("accepts runId with underscores and hyphens", async () => {
    const dir = await createRunStaging("run_2026-07-17_xyz");
    expect(existsSync(dir)).toBe(true);
  });
});

describe("writeRunCode", () => {
  it("writes code to main.py for python", async () => {
    const dir = await createRunStaging("run_write1");
    const file = await writeRunCode(dir, "main.py", "print('hi')");
    expect(file).toBe(join(dir, "main.py"));
    expect(readFileSync(file, "utf8")).toBe("print('hi')");
  });

  it("writes code to main.js for javascript", async () => {
    const dir = await createRunStaging("run_write2");
    const file = await writeRunCode(dir, "main.js", "console.log(1)");
    expect(readFileSync(file, "utf8")).toBe("console.log(1)");
  });

  it("overwrites existing file", async () => {
    const dir = await createRunStaging("run_write3");
    await writeRunCode(dir, "main.py", "print(1)");
    await writeRunCode(dir, "main.py", "print(2)");
    const file = join(dir, "main.py");
    expect(readFileSync(file, "utf8")).toBe("print(2)");
  });

  it("rejects filename with path traversal", async () => {
    const dir = await createRunStaging("run_write4");
    await expect(writeRunCode(dir, "../escape.py", "x")).rejects.toThrow("invalid filename");
    await expect(writeRunCode(dir, "sub/main.py", "x")).rejects.toThrow("invalid filename");
  });
});

describe("removeRunStaging", () => {
  it("removes an existing staging directory", async () => {
    const dir = await createRunStaging("run_rm1");
    expect(existsSync(dir)).toBe(true);
    await removeRunStaging(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("is safe to call twice on the same dir", async () => {
    const dir = await createRunStaging("run_rm2");
    await removeRunStaging(dir);
    await expect(removeRunStaging(dir)).resolves.toBeUndefined();
  });

  it("does not throw when removing a non-existent dir", async () => {
    await expect(removeRunStaging(join(tempRoot, "never-existed"))).resolves.toBeUndefined();
  });
});

describe("filenameForLanguage", () => {
  it("returns main.py for python", () => {
    expect(filenameForLanguage("python")).toBe("main.py");
  });

  it("returns main.js for javascript", () => {
    expect(filenameForLanguage("javascript")).toBe("main.js");
  });
});
