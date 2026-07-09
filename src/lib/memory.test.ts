// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { memories, threads } from "@/db/schema";
import { eq } from "drizzle-orm";

// Mock embedText / hashContent: return deterministic vectors without depending on
// the real embedder service (memories table is vector(1024)).
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

// Unit tests for generateMemories. Mocks the LLM and verifies that memories are
// correctly stored, updated, and soft-deleted in the DB. embedText uses the real
// implementation (HTTP embedder or transformers.js).

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
  // Create a test thread
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
  it("new action INSERTs into the memories table", async () => {
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

  it("replace action sets suppressedAt on the target memory", async () => {
    const threadId = createdThreadIds[0];
    // The target existing memory's content is "User uses RTX 5070 Ti"
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

    // Old memory is suppressed
    const [old] = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "User uses RTX 5070 Ti"));
    expect(old).toBeDefined();
    expect(old!.suppressedAt).not.toBeNull();

    // New memory is inserted
    const [newRow] = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "User upgraded to RTX 5080"));
    expect(newRow).toBeDefined();
    expect(newRow!.suppressedAt).toBeNull();
    createdMemoryIds.push(newRow!.id);
  }, 60_000);

  it("merge action updates the target memory's content", async () => {
    const threadId = createdThreadIds[0];
    // Merge against existing memory "User upgraded to RTX 5080"
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
    // The mergeContents LLM response also comes from the same mock (2nd create call)
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

    // Target memory's content is merged
    const [merged] = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "User upgraded to RTX 5080 and has 64GB RAM"));
    expect(merged).toBeDefined();
    expect(merged!.suppressedAt).toBeNull();
  }, 60_000);

  it("when LLM returns invalid JSON, skips without throwing", async () => {
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

  it("early return when recentTurns is empty", async () => {
    const threadId = createdThreadIds[0];
    const llm = mockLLM("[]");

    await expect(
      generateMemories(threadId, [], llm, "test-model"),
    ).resolves.toBeUndefined();
    // LLM is not called
    expect(llm.chat.completions.create).not.toHaveBeenCalled();
  });

  it("early return when no user/assistant pair", async () => {
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
