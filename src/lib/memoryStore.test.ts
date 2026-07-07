// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { memories, threads, folders, users } from "@/db/schema";
import { eq, ne, desc } from "drizzle-orm";

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
import { findRelevantMemories, buildMemoryContext, fetchRecentThreadTitles } from "@/lib/memoryStore";

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


describe("fetchRecentThreadTitles", () => {
  const userIds: string[] = [];
  const titleThreadIds: string[] = [];

  beforeAll(async () => {
    const [user] = await db.insert(users).values({
      nickname: "titles-test-user",
      email: "titles-test@example.com",
    }).returning();
    userIds.push(user.id);
  });

  afterAll(async () => {
    for (const id of titleThreadIds) {
      await db.delete(threads).where(eq(threads.id, id));
    }
    for (const id of userIds) {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("現在スレッドと New chat を除外し updatedAt 降順で返す", async () => {
    const uid = userIds[0];
    // updatedAt を意図的にずらすため順に挿入し、後に手動で上書きする
    const now = Date.now();
    const [t1] = await db.insert(threads).values({
      userId: uid,
      title: "一番古いスレッド",
      updatedAt: new Date(now),
    }).returning();
    const [t2] = await db.insert(threads).values({
      userId: uid,
      title: "New chat",
      updatedAt: new Date(now + 1000),
    }).returning();
    const [t3] = await db.insert(threads).values({
      userId: uid,
      title: "最新スレッド",
      updatedAt: new Date(now + 2000),
    }).returning();
    titleThreadIds.push(t1.id, t2.id, t3.id);

    // t3 を「現在のスレッド」として渡す → t3 は除外、t2 は "New chat" で除外、t1 のみ残る
    const titles = await fetchRecentThreadTitles(uid, t3.id);
    expect(titles).toEqual(["一番古いスレッド"]);
  }, 60_000);

  it("該当スレッドが無い場合は空配列を返す", async () => {
    const uid = userIds[0];
    // 存在しないスレッド ID を「現在」として渡す → 全スレッド候補だが
    // 他のテストで作った分が混ざるのを避けるため別ユーザーで検証したいが、
    // ここは単純に存在しない userId で空配列になることを確認する。
    const titles = await fetchRecentThreadTitles("nonexistent-user-id", "nonexistent-thread-id");
    expect(titles).toEqual([]);
  }, 60_000);
});

describe("buildMemoryContext with titles", () => {
  const userIds: string[] = [];
  const ctxThreadIds: string[] = [];
  const ctxFolderIds: string[] = [];
  const ctxMemoryIds: string[] = [];

  beforeAll(async () => {
    const [user] = await db.insert(users).values({
      nickname: "ctx-titles-test-user",
      email: "ctx-titles-test@example.com",
    }).returning();
    userIds.push(user.id);
  });

  afterAll(async () => {
    for (const id of ctxMemoryIds) {
      await db.delete(memories).where(eq(memories.id, id));
    }
    for (const id of ctxThreadIds) {
      await db.delete(threads).where(eq(threads.id, id));
    }
    for (const id of ctxFolderIds) {
      await db.delete(folders).where(eq(folders.id, id));
    }
    for (const id of userIds) {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("タイトルが無く記憶も無い場合は null を返す", async () => {
    const uid = userIds[0];
    // 専用フォルダを作り、そのスレッドは1つだけ（他にスレッド無し）
    const [folder] = await db.insert(folders).values({
      name: "ctx-null-folder",
      memoryScope: "folder",
    }).returning();
    ctxFolderIds.push(folder.id);
    const [thread] = await db.insert(threads).values({
      userId: uid,
      title: "New chat",
      folderId: folder.id,
    }).returning();
    ctxThreadIds.push(thread.id);

    const result = await buildMemoryContext({
      content: "何か質問",
      thread: { folderId: folder.id },
      userId: uid,
      currentThreadId: thread.id,
    });
    // タイトル候補無し（New chat 除外）+ 記憶無し → null
    expect(result).toBeNull();
  }, 60_000);

  it("記憶がヒットしなくてもタイトル一覧を注入する", async () => {
    const uid = userIds[0];
    // 専用フォルダで記憶スコープを分離し、グローバル記憶にヒットしないようにする
    const [folder] = await db.insert(folders).values({
      name: "ctx-title-only-folder",
      memoryScope: "folder",
    }).returning();
    ctxFolderIds.push(folder.id);
    const [t1] = await db.insert(threads).values({
      userId: uid,
      title: "FPGA の話",
      folderId: folder.id,
    }).returning();
    const [t2] = await db.insert(threads).values({
      userId: uid,
      title: "Rust の話",
      folderId: folder.id,
    }).returning();
    ctxThreadIds.push(t1.id, t2.id);

    // t2 を「現在のスレッド」とする。folder スコープ内に記憶は無いが
    // タイトル候補として t1 が残るはず。
    const result = await buildMemoryContext({
      content: "全く関係ない質問 xyz123",
      thread: { folderId: folder.id },
      userId: uid,
      currentThreadId: t2.id,
    });
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Recent conversation topics");
    expect(result!.content).toContain("FPGA の話");
  }, 60_000);

  it("タイトルと記憶の両方がある場合は両セクションを含む", async () => {
    const uid = userIds[0];
    const [folder] = await db.insert(folders).values({
      name: "ctx-both-folder",
      memoryScope: "folder",
    }).returning();
    ctxFolderIds.push(folder.id);
    const [t1] = await db.insert(threads).values({
      userId: uid,
      title: "過去の設計議論",
      folderId: folder.id,
    }).returning();
    const [t2] = await db.insert(threads).values({
      userId: uid,
      title: "現在のタスク",
      folderId: folder.id,
    }).returning();
    ctxThreadIds.push(t1.id, t2.id);

    // t2 のフォルダに記フォルダに記憶を挿入 → folder スコープでヒットするはず
    await insertMemory(t2.id, folder.id, "ユーザーは FPGA 開発をしている", "fact");

    const result = await buildMemoryContext({
      content: "FPGA 開発",
      thread: { folderId: folder.id },
      userId: uid,
      currentThreadId: t2.id,
    });
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Recent conversation topics");
    expect(result!.content).toContain("過去の設計議論");
    expect(result!.content).toContain("Past memories from previous conversations");
    expect(result!.content).toContain("FPGA 開発をしている");
  }, 60_000);
});