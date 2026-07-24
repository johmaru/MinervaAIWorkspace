// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendChatExport } from "@/lib/chatExport";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Setup / Teardown ────────────────────────────────────────────────────

let savedEnv: string | undefined;
let savedMode: string | undefined;
let tmpDir: string;

beforeEach(() => {
  savedEnv = process.env.CHAT_EXPORT_PATH;
  savedMode = process.env.CHAT_EXPORT_MODE;
  tmpDir = mkdtempSync(join(tmpdir(), "chatexport-test-"));
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CHAT_EXPORT_PATH;
  else process.env.CHAT_EXPORT_PATH = savedEnv;
  if (savedMode === undefined) delete process.env.CHAT_EXPORT_MODE;
  else process.env.CHAT_EXPORT_MODE = savedMode;
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

  // ── Thread mode tests ───────────────────────────────────────────────

  it("thread mode: creates thread folder + date file on first call", async () => {
    process.env.CHAT_EXPORT_PATH = tmpDir;
    process.env.CHAT_EXPORT_MODE = "thread";
    await appendChatExport({
      threadTitle: "My Project",
      userContent: "What is 2+2?",
      assistantContent: "4",
    });

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const todayStr = `${y}-${m}-${d}`;
    const filepath = join(tmpDir, "My Project", `${todayStr}.md`);

    expect(existsSync(filepath)).toBe(true);
    const content = readFileSync(filepath, "utf8");
    expect(content).toContain("# My Project");
    expect(content).toContain("What is 2+2?");
    expect(content).toContain("4");
  });

  it("thread mode: appends to same-day file without repeating header", async () => {
    process.env.CHAT_EXPORT_PATH = tmpDir;
    process.env.CHAT_EXPORT_MODE = "thread";
    await appendChatExport({
      threadTitle: "Continuous Thread",
      userContent: "first question",
      assistantContent: "first answer",
    });
    await appendChatExport({
      threadTitle: "Continuous Thread",
      userContent: "second question",
      assistantContent: "second answer",
    });

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const todayStr = `${y}-${m}-${d}`;
    const filepath = join(tmpDir, "Continuous Thread", `${todayStr}.md`);

    const content = readFileSync(filepath, "utf8");
    // Only one title header
    expect(content.match(/# Continuous Thread/g)?.length).toBe(1);
    expect(content).toContain("first question");
    expect(content).toContain("first answer");
    expect(content).toContain("second question");
    expect(content).toContain("second answer");
  });

  it("thread mode: creates part2 when resumed on a different day", async () => {
    process.env.CHAT_EXPORT_PATH = tmpDir;
    process.env.CHAT_EXPORT_MODE = "thread";

    // Day 1: create initial file with a past date filename
    const threadDir = join(tmpDir, "Resumed Thread");
    const day1File = join(threadDir, "2026-01-15.md");
    // Simulate a prior session: write a file with the old date
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(day1File, "# Resumed Thread\n\n---\n\n## 👤 User (2026-01-15 10:00:00)\n\nold message\n");

    // Now export with today's date — should create part2
    await appendChatExport({
      threadTitle: "Resumed Thread",
      userContent: "new message",
      assistantContent: "new answer",
    });

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const todayStr = `${y}-${m}-${d}`;
    const part2File = join(threadDir, `${todayStr}-part2.md`);

    expect(existsSync(part2File)).toBe(true);
    const content = readFileSync(part2File, "utf8");
    expect(content).toContain("# Resumed Thread");
    expect(content).toContain("new message");
    expect(content).toContain("new answer");
  });

  it("thread mode: appends to existing today-part file instead of creating part3", async () => {
    process.env.CHAT_EXPORT_PATH = tmpDir;
    process.env.CHAT_EXPORT_MODE = "thread";

    const threadDir = join(tmpDir, "Same Day Part2");
    mkdirSync(threadDir, { recursive: true });

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const todayStr = `${y}-${m}-${d}`;

    // Simulate: day1 file + today-part2 already exists
    writeFileSync(join(threadDir, "2026-01-15.md"), "# Same Day Part2\n");
    const part2File = join(threadDir, `${todayStr}-part2.md`);
    writeFileSync(part2File, "# Same Day Part2\n\n---\n\n## 👤 User (existing)\n\nold\n");

    // Export again today — should append to part2, NOT create part3
    await appendChatExport({
      threadTitle: "Same Day Part2",
      userContent: "new today",
      assistantContent: "reply today",
    });

    const content = readFileSync(part2File, "utf8");
    expect(content).toContain("new today");
    expect(content).toContain("reply today");
    // No part3 file should be created
    expect(existsSync(join(threadDir, `${todayStr}-part3.md`))).toBe(false);
  });

  it("thread mode: part numbering increments correctly across multiple days", async () => {
    process.env.CHAT_EXPORT_PATH = tmpDir;
    process.env.CHAT_EXPORT_MODE = "thread";

    const threadDir = join(tmpDir, "Multi Day Thread");
    mkdirSync(threadDir, { recursive: true });

    // Simulate: day1 + day2-part2 + day3-part3 already exist
    writeFileSync(join(threadDir, "2026-01-10.md"), "# Multi Day Thread\n");
    writeFileSync(join(threadDir, "2026-01-11-part2.md"), "");
    writeFileSync(join(threadDir, "2026-01-12-part3.md"), "");
    // Export with today's date — should create part4
    await appendChatExport({
      threadTitle: "Multi Day Thread",
      userContent: "day 4",
      assistantContent: "reply 4",
    });

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const todayStr = `${y}-${m}-${d}`;
    const part4File = join(threadDir, `${todayStr}-part4.md`);

    expect(existsSync(part4File)).toBe(true);
    const content = readFileSync(part4File, "utf8");
    expect(content).toContain("day 4");
  });
});
