// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { memories, threads } from "@/db/schema";
import { eq } from "drizzle-orm";

// embedText / hashContent をモック: 実 embedder サービスに依存せず、
// 決定論的ベクトルを返す（memories テーブルは vector(1024)）。
vi.mock("@/lib/embed", () => ({
  embedText: vi.fn().mockImplementation(async (text: string) => {
    const hash = createHash("sha256").update(text).digest();
    return Array.from({ length: 1024 }, (_, i) => (hash[i % 32] ?? 0) / 255);
  }),
  hashContent: vi.fn().mockImplementation((text: string) => {
    return createHash("sha256").update(text).digest("hex");
  }),
}));

import { generateMemories } from "@/lib/memory";

// generateMemories の単体テスト。LLM をモックし、DB に記憶が正しく保存・
// 更新・論理削除されることを検証する。embedText は実物（HTTP embedder または
// transformers.js）を使用する。

function mockLLM(responseContent: string): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: responseContent } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

const createdThreadIds: string[] = [];
const createdMemoryIds: string[] = [];

beforeAll(async () => {
  // テスト用スレッドを作成
  const [thread] = await db.insert(threads).values({ title: "memory test" }).returning();
  createdThreadIds.push(thread.id);
});

afterAll(async () => {
  for (const id of createdMemoryIds) {
    await db.delete(memories).where(eq(memories.id, id));
  }
  for (const id of createdThreadIds) {
    await db.delete(memories).where(eq(memories.threadId, id));
    await db.delete(threads).where(eq(threads.id, id));
  }
});

describe("generateMemories", () => {
  it("new action で memories テーブルに INSERT する", async () => {
    const threadId = createdThreadIds[0];
    const llm = mockLLM(
      JSON.stringify([
        { kind: "fact", content: "User uses RTX 5070 Ti", importance: 0.8, action: "new" },
      ]),
    );

    await generateMemories(
      threadId,
      [
        { role: "user", content: "I use RTX 5070 Ti" },
        { role: "assistant", content: "Got it, you have an RTX 5070 Ti." },
      ],
      llm,
      "test-model",
    );

    const [row] = await db
      .select()
      .from(memories)
      .where(eq(memories.threadId, threadId));
    expect(row).toBeDefined();
    expect(row!.kind).toBe("fact");
    expect(row!.content).toBe("User uses RTX 5070 Ti");
    expect(row!.importance).toBe(0.8);
    expect(row!.suppressedAt).toBeNull();
    createdMemoryIds.push(row!.id);
  }, 60_000);

  it("replace action で対象記憶に suppressedAt が設定される", async () => {
    const threadId = createdThreadIds[0];
    // 対象となる既存記憶の content は "User uses RTX 5070 Ti"
    const llm = mockLLM(
      JSON.stringify([
        {
          kind: "fact",
          content: "User upgraded to RTX 5080",
          importance: 0.8,
          action: "replace",
          targetContent: "User uses RTX 5070 Ti",
        },
      ]),
    );

    await generateMemories(
      threadId,
      [
        { role: "user", content: "I upgraded to RTX 5080" },
        { role: "assistant", content: "Noted the upgrade." },
      ],
      llm,
      "test-model",
    );

    // 古い記憶が suppressed されている
    const [old] = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "User uses RTX 5070 Ti"));
    expect(old).toBeDefined();
    expect(old!.suppressedAt).not.toBeNull();

    // 新しい記憶が挿入されている
    const [newRow] = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "User upgraded to RTX 5080"));
    expect(newRow).toBeDefined();
    expect(newRow!.suppressedAt).toBeNull();
    createdMemoryIds.push(newRow!.id);
  }, 60_000);

  it("merge action で対象記憶の content が更新される", async () => {
    const threadId = createdThreadIds[0];
    // 既存記憶 "User upgraded to RTX 5080" に対して merge
    const llm = mockLLM(
      JSON.stringify([
        {
          kind: "fact",
          content: "User also has 64GB RAM",
          importance: 0.7,
          action: "merge",
          targetContent: "User upgraded to RTX 5080",
        },
      ]),
    );
    // mergeContents の LLM レスポンスも同じ mock から返る（2回目の create 呼び出し）
    llm.chat.completions.create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify([
          {
            kind: "fact",
            content: "User also has 64GB RAM",
            importance: 0.7,
            action: "merge",
            targetContent: "User upgraded to RTX 5080",
          },
        ]) } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: "User upgraded to RTX 5080 and has 64GB RAM" } }],
      }) as never;

    await generateMemories(
      threadId,
      [
        { role: "user", content: "I also have 64GB RAM" },
        { role: "assistant", content: "Got it." },
      ],
      llm,
      "test-model",
    );

    // 対象記憶の content が統合されている
    const [merged] = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "User upgraded to RTX 5080 and has 64GB RAM"));
    expect(merged).toBeDefined();
    expect(merged!.suppressedAt).toBeNull();
  }, 60_000);

  it("LLM が不正 JSON を返した場合、スキップしてエラーを投げない", async () => {
    const threadId = createdThreadIds[0];
    const llm = mockLLM("this is not json at all");

    await expect(
      generateMemories(
        threadId,
        [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
        llm,
        "test-model",
      ),
    ).resolves.toBeUndefined();
  });

  it("recentTurns が空の場合、早期リターン", async () => {
    const threadId = createdThreadIds[0];
    const llm = mockLLM("[]");

    await expect(
      generateMemories(threadId, [], llm, "test-model"),
    ).resolves.toBeUndefined();
    // LLM は呼ばれない
    expect(llm.chat.completions.create).not.toHaveBeenCalled();
  });

  it("user/assistant ペアが無い場合は早期リターン", async () => {
    const threadId = createdThreadIds[0];
    const llm = mockLLM("[]");

    await expect(
      generateMemories(
        threadId,
        [{ role: "user", content: "only user message" }],
        llm,
        "test-model",
      ),
    ).resolves.toBeUndefined();
    expect(llm.chat.completions.create).not.toHaveBeenCalled();
  });
});
