// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extractFileTextFromPath } from "@/lib/fileExtract";

describe("extractFileTextFromPath — disk read cap", () => {
  let dir = "";
  afterEach(() => {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      dir = "";
    }
  });

  it("truncates text files larger than 2MB", async () => {
    dir = join(tmpdir(), `minerva-fileextract-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "big.txt");
    writeFileSync(filePath, "b".repeat(2 * 1024 * 1024 + 50));
    const out = await extractFileTextFromPath(filePath, "big.txt");
    expect(out.text.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(out.empty).toBe(false);
  });

  it("reads small text files fully", async () => {
    dir = join(tmpdir(), `minerva-fileextract-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "small.md");
    writeFileSync(filePath, "hello world");
    const out = await extractFileTextFromPath(filePath, "small.md");
    expect(out.text).toBe("hello world");
  });
});
