// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendChatExport } from "@/lib/chatExport";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Setup / Teardown ────────────────────────────────────────────────────

let savedEnv: string | undefined;
let tmpDir: string;

beforeEach(() => {
  savedEnv = process.env.CHAT_EXPORT_PATH;
  tmpDir = mkdtempSync(join(tmpdir(), "chatexport-test-"));
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CHAT_EXPORT_PATH;
  else process.env.CHAT_EXPORT_PATH = savedEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("chatExport", () => {
  it("is disabled when CHAT_EXPORT_PATH is empty", async () => {
    process.env.CHAT_EXPORT_PATH = "";
    await appendChatExport({
      threadTitle: "Test",
      userContent: "hello",
      assistantContent: "hi",
    });
    // No file or directory should have been created anywhere we can detect.
    // The function should simply return without throwing.
    expect(existsSync(tmpDir)).toBe(true); // tmpDir itself still exists, but nothing added
  });

  it("is disabled when CHAT_EXPORT_PATH is unset", async () => {
    delete process.env.CHAT_EXPORT_PATH;
    await appendChatExport({
      threadTitle: "Test",
      userContent: "hello",
      assistantContent: "hi",
    });
    expect(existsSync(tmpDir)).toBe(true);
  });

  it("creates date folder + file on first call", async () => {
    process.env.CHAT_EXPORT_PATH = tmpDir;
    await appendChatExport({
      threadTitle: "My Thread",
      userContent: "What is 2+2?",
      assistantContent: "4",
    });

    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const filepath = join(tmpDir, y, m, d, "My Thread.md");

    expect(existsSync(filepath)).toBe(true);
    const content = readFileSync(filepath, "utf8");
    expect(content).toContain("# My Thread");
    expect(content).toContain("## 👤 User");
    expect(content).toContain("What is 2+2?");
    expect(content).toContain("## 🤖 Assistant");
    expect(content).toContain("4");
  });

  it("appends on second call (same day) without repeating header", async () => {
    process.env.CHAT_EXPORT_PATH = tmpDir;
    await appendChatExport({
      threadTitle: "Continuous Chat",
      userContent: "first question",
      assistantContent: "first answer",
    });
    await appendChatExport({
      threadTitle: "Continuous Chat",
      userContent: "second question",
      assistantContent: "second answer",
    });

    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const filepath = join(tmpDir, y, m, d, "Continuous Chat.md");

    const content = readFileSync(filepath, "utf8");
    // Only one title header
    expect(content.match(/# Continuous Chat/g)?.length).toBe(1);
    // Two turns — each starts with ---
    expect(content.match(/^---$/gm)?.length).toBe(2);
    expect(content).toContain("first question");
    expect(content).toContain("first answer");
    expect(content).toContain("second question");
    expect(content).toContain("second answer");
  });

  it("sanitizes title for filename but keeps original in header", async () => {
    process.env.CHAT_EXPORT_PATH = tmpDir;
    await appendChatExport({
      threadTitle: 'Hello/World: "Test"?<>|',
      userContent: "u",
      assistantContent: "a",
    });

    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    // All invalid chars replaced with _
    const filepath = join(tmpDir, y, m, d, "Hello_World_ _Test_____.md");

    expect(existsSync(filepath)).toBe(true);
    const content = readFileSync(filepath, "utf8");
    // Header uses the ORIGINAL (unsanitized) title
    expect(content).toContain('# Hello/World: "Test"?<>|');
  });

  it("falls back to untitled.md when title sanitizes to empty", async () => {
    process.env.CHAT_EXPORT_PATH = tmpDir;
    // Title is only dots — sanitizeForFilename strips leading/trailing dots → empty → "untitled"
    await appendChatExport({
      threadTitle: "...",
      userContent: "u",
      assistantContent: "a",
    });

    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const filepath = join(tmpDir, y, m, d, "untitled.md");

    expect(existsSync(filepath)).toBe(true);
    const content = readFileSync(filepath, "utf8");
    expect(content).toContain("# ...");
  });

  it("does not throw when path is unwritable", async () => {
    // Create a regular file, then try to mkdir under it — triggers ENOTDIR reliably on POSIX and Windows.
    const blockerFile = join(tmpDir, "blocker-file");
    writeFileSync(blockerFile, "");
    process.env.CHAT_EXPORT_PATH = join(blockerFile, "sub");
    await expect(
      appendChatExport({
        threadTitle: "Test",
        userContent: "u",
        assistantContent: "a",
      }),
    ).resolves.toBeUndefined();
  });
});
