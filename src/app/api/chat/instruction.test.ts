// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
vi.mock("next/server", () => ({
  after: () => {},
}));
import { db } from "@/db";
import { folders, threads } from "@/db/schema";
import { eq } from "drizzle-orm";

// Mock searchWeb / scrapeUrl only — keep pure helpers from the real module
vi.mock("@/lib/scraper", async () => {
  const actual = await vi.importActual<typeof import("@/lib/scraper")>("@/lib/scraper");
  return {
    ...actual,
    searchWeb: vi.fn().mockResolvedValue({ query: "", results: [] }),
    scrapeUrl: vi.fn(),
  };
});
vi.mock("@/lib/pageStore", () => ({
  upsertPage: vi.fn().mockResolvedValue("mock-page-id"),
}));

// Mock LLM: capture messages, return minimal stream
let capturedMessages: Array<{ role: string; content: unknown }> = [];
vi.mock("@/lib/llm", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm")>("@/lib/llm");
  return {
    ...actual,
    createLLM: () => ({
      chat: {
        completions: {
          create: async (params: {
            messages: Array<{ role: string; content: unknown }>;
          }) => {
            capturedMessages = params.messages;
            return (async function* () {
              yield { choices: [{ delta: { content: "応答" } }] };
            })();
          },
        },
      },
    }),
  };
});

import { POST } from "@/app/api/chat/route";

const createdIds: string[] = [];
const createdFolderIds: string[] = [];

afterAll(async () => {
  for (const id of createdIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
  for (const id of createdFolderIds) {
    await db.delete(folders).where(eq(folders.id, id));
  }
});

function chatReq(threadId: string, content: string): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify({ threadId, content }),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/chat — folder instruction integration", () => {
  it("folder.instruction is prepended to the system message", async () => {
    // Create folder + with instruction
    const [folder] = await db
      .insert(folders)
      .values({
        name: "敬語フォルダ",
        userId: "test-user-id",
        instruction: "丁寧な敬語で回答してください",
      })
      .returning();
    createdFolderIds.push(folder.id);

    // Create thread + assign folder + thread-specific systemPrompt
    const [thread] = await db
      .insert(threads)
      .values({
        title: "instruction test",
        userId: "test-user-id",
        folderId: folder.id,
        systemPrompt: "簡潔に答えて",
      })
      .returning();
    createdIds.push(thread.id);

    const res = await POST(chatReq(thread.id, "こんにちは"));
    expect(res.status).toBe(200);
    await res.text(); // consume stream

    // Both instruction and systemPrompt are included in the system message.
    // Since getEnvContext()'s "Current date:" message comes first,
    // we identify the prompt-related system message specifically.
    const systemMessages = capturedMessages.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    const promptSystem = String(
      systemMessages.find((m) => !String(m.content).startsWith("Current date:"))?.content ?? "",
    );
    expect(promptSystem).toContain("丁寧な敬語で回答してください");
    expect(promptSystem).toContain("簡潔に答えて");
    // instruction comes first
    expect(promptSystem.indexOf("丁寧な敬語")).toBeLessThan(
      promptSystem.indexOf("簡潔に答えて"),
    );
  }, 30_000);

  it("when folder.instruction is null, only thread.systemPrompt is used", async () => {
    const [folder] = await db
      .insert(folders)
      .values({ name: "空フォルダ", userId: "test-user-id", instruction: null })
      .returning();
    createdFolderIds.push(folder.id);

    const [thread] = await db
      .insert(threads)
      .values({
        title: "no instruction",
        userId: "test-user-id",
        folderId: folder.id,
        systemPrompt: "短く答えて",
      })
      .returning();
    createdIds.push(thread.id);
    const res = await POST(chatReq(thread.id, "テスト"));
    expect(res.status).toBe(200);
    await res.text();

    const systemMessages = capturedMessages.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    const promptSystem = String(
      systemMessages.find((m) => !String(m.content).startsWith("Current date:"))?.content ?? "",
    );
    expect(promptSystem).toBe("短く答えて");
  }, 30_000);

  it("threads without a folder use only thread.systemPrompt", async () => {
    const [thread] = await db
      .insert(threads)
      .values({ title: "no folder", userId: "test-user-id", systemPrompt: "通常プロンプト" })
      .returning();
    createdIds.push(thread.id);

    const res = await POST(chatReq(thread.id, "hi"));
    expect(res.status).toBe(200);
    await res.text();

    const systemMessages = capturedMessages.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    const promptSystem = String(
      systemMessages.find((m) => !String(m.content).startsWith("Current date:"))?.content ?? "",
    );
    expect(promptSystem).toBe("通常プロンプト");
  }, 30_000);

  it("whitespace-only instruction is excluded from systemContent", async () => {
    // Set up whitespace-only instruction directly in DB (API would trim it)
    const [folder] = await db
      .insert(folders)
      .values({ name: "空白フォルダ", userId: "test-user-id", instruction: "   " })
      .returning();
    createdFolderIds.push(folder.id);

    const [thread] = await db
      .insert(threads)
      .values({
        title: "whitespace test",
        userId: "test-user-id",
        folderId: folder.id,
        systemPrompt: "有効プロンプト",
      })
      .returning();
    createdIds.push(thread.id);

    const res = await POST(chatReq(thread.id, "hi"));
    expect(res.status).toBe(200);
    await res.text();

    const systemMessages = capturedMessages.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    const promptSystem = String(
      systemMessages.find((m) => !String(m.content).startsWith("Current date:"))?.content ?? "",
    );
    // whitespace-only instruction is excluded, only systemPrompt remains
    expect(promptSystem).toBe("有効プロンプト");
  }, 30_000);

  it("includes rich-block syntax rules in system messages", async () => {
    const [thread] = await db
      .insert(threads)
      .values({ title: "rich block test", userId: "test-user-id", systemPrompt: null })
      .returning();
    createdIds.push(thread.id);

    const res = await POST(chatReq(thread.id, "hello"));
    expect(res.status).toBe(200);
    await res.text();

    const systemMessages = capturedMessages.filter((m) => m.role === "system");
    const richMsg = systemMessages.find((m) => String(m.content).includes(":::callout"));
    expect(richMsg).toBeDefined();
    expect(String(richMsg?.content)).toContain(":mark[");
    expect(String(richMsg?.content)).toContain(":::richlist");
  }, 30_000);
});
