// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { memories, threads, folders, users } from "@/db/schema";
import { eq, ne, desc } from "drizzle-orm";

// Mock embedText: return deterministic vectors without depending on the real embedder service.
// Generates a 1024-dimensional pseudo-vector from the content hash, so identical content yields identical vectors.
vi.mock("@/lib/embed", () => ({
  embedText: vi.fn().mockImplementation(async (text: string) => {
    // bag-of-characters: set each character's code position to 1. Content with the same characters
    // produces similar vectors (high cosine similarity).
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

// Integration test for findRelevantMemories. Inserts memories into the real DB and
// verifies that client-side cosine search returns similarity + recency top-5.

const createdThreadIds: string[] = [];
const createdFolderIds: string[] = [];
const createdMemoryIds: string[] = [];
const createdUserIds: string[] = [];
let testUserId: string;

async function insertMemory(
  threadId: string,
  folderId: string | null,
  content: string,
  kind: "fact" | "working" = "fact",
): Promise<string> {
  // Generate vector via mock embedText and contentHash via hashContent
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
  // Create test user (for userId isolation tests)
  const [testUser] = await db.insert(users).values({
    nickname: "memoryStore-test",
    email: "memstore-test@umanschat.test",
  }).returning();
  testUserId = testUser.id;
  createdUserIds.push(testUser.id);

  // Thread A (no folder = global scope)
  const [threadA] = await db.insert(threads).values({ title: "memoryStore test A", userId: testUser.id }).returning();
  createdThreadIds.push(threadA.id);

  // Folder + Thread B (folder scope)
  const [folder] = await db.insert(folders).values({ name: "test folder", memoryScope: "folder", userId: testUser.id }).returning();
  createdFolderIds.push(folder.id);
  const [threadB] = await db
    .insert(threads)
    .values({ title: "memoryStore test B", folderId: folder.id, userId: testUser.id })
    .returning();
  createdThreadIds.push(threadB.id);

  // Thread C (different folder = folder scope)
  const [folder2] = await db.insert(folders).values({ name: "other folder", memoryScope: "folder", userId: testUser.id }).returning();
  createdFolderIds.push(folder2.id);
  const [threadC] = await db
    .insert(threads)
    .values({ title: "memoryStore test C", folderId: folder2.id, userId: testUser.id })
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
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("findRelevantMemories", () => {
  it("relevant query hits memories (similarity > 0.3)", async () => {
    const threadId = createdThreadIds[0];
    await insertMemory(threadId, null, "ユーザーは FPGA と低レイヤー開発を得意としている");
    const results = await findRelevantMemories("FPGA 低レイヤー 開発", null, testUserId);

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.similarity > 0.3)).toBe(true);
    // FPGA memory is included in results
    expect(results.some((r) => r.content.includes("FPGA"))).toBe(true);
  }, 60_000);

  it("memories with suppressed_at set are not searched", async () => {
    const threadId = createdThreadIds[0];
    const memId = await insertMemory(threadId, null, "一時的な作業メモ： suppressed test");
    await db.update(memories).set({ suppressedAt: new Date() }).where(eq(memories.id, memId));
    const results = await findRelevantMemories("suppressed test", null, testUserId);

    const hit = results.find((r) => r.id === memId);
    expect(hit).toBeUndefined();
  }, 60_000);

  it("with scope=folder, memories from other folders are not searched", async () => {
    const folderBId = createdFolderIds[0]; // folder scope
    const threadBId = createdThreadIds[1];

    // Insert memory into folder B (scope=folder)
    await insertMemory(threadBId, folderBId, "フォルダB固有の記憶： Rust で組み込み開発");

    const resultsB = await findRelevantMemories("Rust 組み込み開発", folderBId, testUserId);
    expect(resultsB.some((r) => r.content.includes("フォルダB固有"))).toBe(true);

    // Search from folder C's thread → folder B's memory should not hit
    const folderCId = createdFolderIds[1];
    const resultsC = await findRelevantMemories("Rust 組み込み開発", folderCId, testUserId);
    expect(resultsC.some((r) => r.content.includes("フォルダB固有"))).toBe(false);
  }, 60_000);

  it("returns top-5 by similarity + recency", async () => {
    const threadId = createdThreadIds[0];
    // Insert multiple memories
    await insertMemory(threadId, null, "ユーザーは Python が好き", "fact");
    await insertMemory(threadId, null, "ユーザーは TypeScript も使う", "fact");
    await insertMemory(threadId, null, "現在のタスク： API設計中", "working");
    const results = await findRelevantMemories("Python TypeScript", null, testUserId);

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    // Similar memories are included in results
    expect(results.some((r) => r.content.includes("Python") || r.content.includes("TypeScript"))).toBe(true);
  }, 60_000);
});

describe("findRelevantMemories — userId isolation", () => {
  const otherUserIds: string[] = [];
  const otherThreadIds: string[] = [];
  const otherMemoryIds: string[] = [];

  afterAll(async () => {
    for (const id of otherMemoryIds) {
      await db.delete(memories).where(eq(memories.id, id));
    }
    for (const id of otherThreadIds) {
      await db.delete(threads).where(eq(threads.id, id));
    }
    for (const id of otherUserIds) {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("other users' memories are not included in search results", async () => {
    // Create another user
    const [otherUser] = await db.insert(users).values({
      nickname: "other-user",
      email: "other-user@umanschat.test",
    }).returning();
    otherUserIds.push(otherUser.id);

    // Create another user's thread + memory (same content as testUserId's for high similarity)
    const [otherThread] = await db.insert(threads).values({
      title: "other user thread",
      userId: otherUser.id,
    }).returning();
    otherThreadIds.push(otherThread.id);

    const embedding = await embedText("ユーザーは FPGA と低レイヤー開発を得意としている");
    const contentHash = hashContent("ユーザーは FPGA と低レイヤー開発を得意としている");
    const [otherMem] = await db.insert(memories).values({
      threadId: otherThread.id,
      kind: "fact",
      content: "他ユーザーの秘密の記憶： FPGA 低レイヤー開発",
      importance: 0.5,
      contentHash,
      embedding,
      model: "test-model",
    }).returning();
    otherMemoryIds.push(otherMem.id);

    // Search with testUserId → other user's memory should not be included
    const results = await findRelevantMemories("FPGA 低レイヤー 開発", null, testUserId);
    const leaked = results.find((r) => r.content.includes("他ユーザーの秘密の記憶"));
    expect(leaked).toBeUndefined();
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

  it("excludes current thread and 'New chat', returns by updatedAt descending", async () => {
    const uid = userIds[0];
    // Insert in order to deliberately offset updatedAt, then manually overwrite later
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

    // Pass t3 as the "current thread" → t3 is excluded, t2 is excluded as "New chat", only t1 remains
    const titles = await fetchRecentThreadTitles(uid, t3.id);
    expect(titles).toEqual(["一番古いスレッド"]);
  }, 60_000);

  it("returns empty array when no matching threads", async () => {
    const uid = userIds[0];
    // Pass a nonexistent thread ID as "current" → all threads are candidates, but
    // to avoid mixing in threads created by other tests, we verify with a different user.
    // Here we simply confirm that a nonexistent userId returns an empty array.
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

  it("returns null when there are no titles and no memories", async () => {
    const uid = userIds[0];
    // Create a dedicated folder with only one thread (no other threads)
    const [folder] = await db.insert(folders).values({
      name: "ctx-null-folder",
      memoryScope: "folder",
      userId: uid,
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
    // No title candidates (New chat excluded) + no memories → null
    expect(result).toBeNull();
  }, 60_000);

  it("injects title list even when no memories hit", async () => {
    const uid = userIds[0];
    // Isolate memory scope with a dedicated folder to avoid hitting global memories
    const [folder] = await db.insert(folders).values({
      name: "ctx-title-only-folder",
      memoryScope: "folder",
      userId: uid,
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

    // Treat t2 as the "current thread". There are no memories in the folder scope,
    // but t1 should remain as a title candidate.
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

  it("when both titles and memories exist, includes both sections", async () => {
    const uid = userIds[0];
    const [folder] = await db.insert(folders).values({
      name: "ctx-both-folder",
      memoryScope: "folder",
      userId: uid,
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

    // Insert memory into t2's folder → should hit with folder scope
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