// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncEnv } from "./sync-env";

describe("sync-env", () => {
  let dir: string;
  let examplePath: string;
  let envPath: string;
  const fixedNow = new Date("2026-06-29T00:00:00.000Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "syncenv-"));
    examplePath = join(dir, ".env.example");
    envPath = join(dir, ".env");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends new keys from .env.example to .env", () => {
    writeFileSync(examplePath, "NEW_KEY=hello\nOTHER=world\n", "utf8");
    writeFileSync(envPath, "EXISTING=old\n", "utf8");

    const added = syncEnv(examplePath, envPath, fixedNow);

    expect(added).toEqual(["NEW_KEY", "OTHER"]);
    const result = readFileSync(envPath, "utf8");
    expect(result).toContain("EXISTING=old");
    expect(result).toContain("NEW_KEY=hello");
    expect(result).toContain("OTHER=world");
    expect(result).toContain(
      "# Auto-merged from .env.example (2026-06-29T00:00:00.000Z)",
    );
  });

  it("does not overwrite existing keys", () => {
    writeFileSync(envPath, "EXISTING=old\n", "utf8");
    writeFileSync(examplePath, "EXISTING=new\n", "utf8");

    const added = syncEnv(examplePath, envPath, fixedNow);

    expect(added).toEqual([]);
    const result = readFileSync(envPath, "utf8");
    // 値は上書きされず元のまま
    expect(result).toContain("EXISTING=old");
    expect(result).not.toContain("EXISTING=new");
  });

  it("exits cleanly when .env.example does not exist", () => {
    // examplePath には何も書かない（存在しない）
    writeFileSync(envPath, "EXISTING=old\n", "utf8");

    const added = syncEnv(examplePath, envPath, fixedNow);

    expect(added).toEqual([]);
    const result = readFileSync(envPath, "utf8");
    expect(result).toBe("EXISTING=old\n");
  });

  it("appends all example keys when .env is empty", () => {
    writeFileSync(examplePath, "FIRST=1\nSECOND=2\n", "utf8");
    writeFileSync(envPath, "", "utf8");

    const added = syncEnv(examplePath, envPath, fixedNow);

    expect(added).toEqual(["FIRST", "SECOND"]);
    const result = readFileSync(envPath, "utf8");
    expect(result).toContain("FIRST=1");
    expect(result).toContain("SECOND=2");
  });

  it("treats commented-out keys as unset and appends them", () => {
    // .env にコメントアウト行として存在 → ^KEY= にマッチしない → 新規扱いで追記
    writeFileSync(envPath, "# COMMENTED=value\n", "utf8");
    writeFileSync(examplePath, "COMMENTED=value\n", "utf8");

    const added = syncEnv(examplePath, envPath, fixedNow);

    expect(added).toEqual(["COMMENTED"]);
    const result = readFileSync(envPath, "utf8");
    expect(result).toContain("# COMMENTED=value");
    expect(result).toContain("COMMENTED=value");
  });

  it("creates .env when it does not exist", () => {
    writeFileSync(examplePath, "NEW=value\n", "utf8");
    // envPath には何も書かない（存在しない）

    const added = syncEnv(examplePath, envPath, fixedNow);

    expect(added).toEqual(["NEW"]);
    const result = readFileSync(envPath, "utf8");
    expect(result).toContain("NEW=value");
  });

  it("skips comments and blank lines in example", () => {
    writeFileSync(
      examplePath,
      "# This is a comment\n\nREAL_KEY=value\n",
      "utf8",
    );
    writeFileSync(envPath, "", "utf8");

    const added = syncEnv(examplePath, envPath, fixedNow);

    expect(added).toEqual(["REAL_KEY"]);
  });

  it("strips surrounding double quotes from example values", () => {
    writeFileSync(examplePath, 'QUOTED="hello world"\n', "utf8");
    writeFileSync(envPath, "", "utf8");

    const added = syncEnv(examplePath, envPath, fixedNow);

    expect(added).toEqual(["QUOTED"]);
    const result = readFileSync(envPath, "utf8");
    expect(result).toContain('QUOTED=hello world');
  });
});
