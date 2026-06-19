// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { folders, threads } from "@/db/schema";
import { eq } from "drizzle-orm";

// searchWeb / upsertPage をモック
vi.mock("@/lib/scraper", () => ({
  searchWeb: vi.fn().mockResolvedValue({ query: "", results: [] }),
  scrapeUrl: vi.fn(),
  normalizeUrl: (u: string) => u,
  SourceInfo: {} as never,
}));
vi.mock("@/lib/pageStore", () => ({
  upsertPage: vi.fn().mockResolvedValue("mock-page-id"),
}));

// LLM をモック: messages を捕捉し、最小ストリームを返す
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

describe("POST /api/chat — フォルダ Instruction 結合", () => {
  it("folder.instruction が system message 先頭に結合される", async () => {
    // フォルダ作成 + Instruction 付き
    const [folder] = await db
      .insert(folders)
      .values({
        name: "敬語フォルダ",
        instruction: "丁寧な敬語で回答してください",
      })
      .returning();
    createdFolderIds.push(folder.id);

    // スレッド作成 + フォルダ割当 + スレッド個別 systemPrompt
    const [thread] = await db
      .insert(threads)
      .values({
        title: "instruction test",
        folderId: folder.id,
        systemPrompt: "簡潔に答えて",
      })
      .returning();
    createdIds.push(thread.id);

    const res = await POST(chatReq(thread.id, "こんにちは"));
    expect(res.status).toBe(200);
    await res.text(); // ストリーム消費

    // system message に instruction と systemPrompt 両方が含まれる
    const systemMessages = capturedMessages.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    const firstSystem = String(systemMessages[0].content);
    expect(firstSystem).toContain("丁寧な敬語で回答してください");
    expect(firstSystem).toContain("簡潔に答えて");
    // instruction が先頭に来る
    expect(firstSystem.indexOf("丁寧な敬語")).toBeLessThan(
      firstSystem.indexOf("簡潔に答えて"),
    );
  }, 30_000);

  it("folder.instruction が null の場合は thread.systemPrompt のみ", async () => {
    const [folder] = await db
      .insert(folders)
      .values({ name: "空フォルダ", instruction: null })
      .returning();
    createdFolderIds.push(folder.id);

    const [thread] = await db
      .insert(threads)
      .values({
        title: "no instruction",
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
    const firstSystem = String(systemMessages[0].content);
    expect(firstSystem).toBe("短く答えて");
  }, 30_000);

  it("フォルダ未所属スレッドは thread.systemPrompt のみ", async () => {
    const [thread] = await db
      .insert(threads)
      .values({ title: "no folder", systemPrompt: "通常プロンプト" })
      .returning();
    createdIds.push(thread.id);

    const res = await POST(chatReq(thread.id, "hi"));
    expect(res.status).toBe(200);
    await res.text();

    const systemMessages = capturedMessages.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThan(0);
    const firstSystem = String(systemMessages[0].content);
    expect(firstSystem).toBe("通常プロンプト");
  }, 30_000);

  it("whitespace-only instruction は systemContent に含まれない", async () => {
    // DB に直接 whitespace-only instruction を仕込む（API 経由だと trim されてしまうため）
    const [folder] = await db
      .insert(folders)
      .values({ name: "空白フォルダ", instruction: "   " })
      .returning();
    createdFolderIds.push(folder.id);

    const [thread] = await db
      .insert(threads)
      .values({
        title: "whitespace test",
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
    const firstSystem = String(systemMessages[0].content);
    // whitespace-only instruction は除外され、systemPrompt のみになる
    expect(firstSystem).toBe("有効プロンプト");
  }, 30_000);
});
