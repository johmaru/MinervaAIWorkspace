// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { memories, threads, folders } from "@/db/schema";
import { eq } from "drizzle-orm";

// embedText をモック: 実 embedder サービスに依存せず、決定論的ベクトルを返す。
// 内容のハッシュを元に1024次元の擬似ベクトルを生成し、同じ内容は同じベクトルになる。
vi.mock("@/lib/embed", () => ({
  embedText: vi.fn().mockImplementation(async (text: string) => {
    // bag-of-characters: 各文字コード位置を1にする。同じ文字を含む内容は
    // 類似ベクトルになる（コサイン類似度が高くなる）。
    const vec = new Array(1024).fill(0);
    for (const ch of text) {
      const code = ch.charCodeAt(0) % 1024;
      vec[code] = 1;
    }
    return vec;
  }),
  hashContent: vi.fn().mockImplementation((text: string) => {
    return createHash("sha256").update(text).digest("hex");
  }),
}));

import { embedText, hashContent } from "@/lib/embed";
import { findRelevantMemories } from "@/lib/memoryStore";

// findRelevantMemories の統合テスト。実 DB に記憶を INSERT し、
// アプリ側 cosine 検索 → similarity + recency top-5 が返ることを検証。

const createdThreadIds: string[] = [];
const createdFolderIds: string[] = [];
const createdMemoryIds: string[] = [];

async function insertMemory(
  threadId: string,
  folderId: string | null,
  content: string,
  kind: "fact" | "working" = "fact",
): Promise<string> {
  // モック embedText でベクトルを生成し、hashContent で contentHash を生成
  const embedding = await embedText(content);
  const contentHash = hashContent(content);
  const [memory] = await db
    .insert(memories)
    .values({
      threadId,
      folderId,
      kind,
      content,
      importance: 0.5,
      contentHash,
      embedding,
      model: "test-model",
    })
    .returning();
  createdMemoryIds.push(memory.id);
  return memory.id;
}

beforeAll(async () => {
  // スレッド A（フォルダなし = global scope）
  const [threadA] = await db.insert(threads).values({ title: "memoryStore test A" }).returning();
  createdThreadIds.push(threadA.id);

  // フォルダ + スレッド B（folder scope）
  const [folder] = await db.insert(folders).values({ name: "test folder", memoryScope: "folder" }).returning();
  createdFolderIds.push(folder.id);
  const [threadB] = await db
    .insert(threads)
    .values({ title: "memoryStore test B", folderId: folder.id })
    .returning();
  createdThreadIds.push(threadB.id);

  // スレッド C（別フォルダ = folder scope）
  const [folder2] = await db.insert(folders).values({ name: "other folder", memoryScope: "folder" }).returning();
  createdFolderIds.push(folder2.id);
  const [threadC] = await db
    .insert(threads)
    .values({ title: "memoryStore test C", folderId: folder2.id })
    .returning();
  createdThreadIds.push(threadC.id);
});

afterAll(async () => {
  for (const id of createdMemoryIds) {
    await db.delete(memories).where(eq(memories.id, id));
  }
  for (const id of createdThreadIds) {
    await db.delete(memories).where(eq(memories.threadId, id));
    await db.delete(threads).where(eq(threads.id, id));
  }
  for (const id of createdFolderIds) {
    await db.delete(folders).where(eq(folders.id, id));
  }
});

describe("findRelevantMemories", () => {
  it("関連クエリで記憶がヒットする（similarity > 0.3）", async () => {
    const threadId = createdThreadIds[0];
    await insertMemory(threadId, null, "ユーザーは FPGA と低レイヤー開発を得意としている");

    const results = await findRelevantMemories("FPGA 低レイヤー 開発", null);

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.similarity > 0.3)).toBe(true);
    // FPGA 記憶が結果に含まれる
    expect(results.some((r) => r.content.includes("FPGA"))).toBe(true);
  }, 60_000);

  it("suppressed_at が設定された記憶は検索されない", async () => {
    const threadId = createdThreadIds[0];
    const memId = await insertMemory(threadId, null, "一時的な作業メモ： suppressed test");
    await db.update(memories).set({ suppressedAt: new Date() }).where(eq(memories.id, memId));

    const results = await findRelevantMemories("suppressed test", null);

    const hit = results.find((r) => r.id === memId);
    expect(hit).toBeUndefined();
  }, 60_000);

  it("scope=folder 指定時、他フォルダの記憶は検索されない", async () => {
    const folderBId = createdFolderIds[0]; // folder scope
    const threadBId = createdThreadIds[1];

    // フォルダB（scope=folder）に記憶を挿入
    await insertMemory(threadBId, folderBId, "フォルダB固有の記憶： Rust で組み込み開発");

    // フォルダBのスレッドから検索 → フォルダBの記憶はヒットする
    const resultsB = await findRelevantMemories("Rust 組み込み開発", folderBId);
    expect(resultsB.some((r) => r.content.includes("フォルダB固有"))).toBe(true);

    // フォルダCのスレッドから検索 → フォルダBの記憶はヒットしない
    const folderCId = createdFolderIds[1];
    const resultsC = await findRelevantMemories("Rust 組み込み開発", folderCId);
    expect(resultsC.some((r) => r.content.includes("フォルダB固有"))).toBe(false);
  }, 60_000);

  it("similarity + recency で top-5 が返る", async () => {
    const threadId = createdThreadIds[0];
    // 複数の記憶を挿入
    await insertMemory(threadId, null, "ユーザーは Python が好き", "fact");
    await insertMemory(threadId, null, "ユーザーは TypeScript も使う", "fact");
    await insertMemory(threadId, null, "現在のタスク： API設計中", "working");

    const results = await findRelevantMemories("Python TypeScript", null);

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    // 類似記憶が結果に含まれる
    expect(results.some((r) => r.content.includes("Python") || r.content.includes("TypeScript"))).toBe(true);
  }, 60_000);
});
