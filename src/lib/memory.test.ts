// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { embedText } from "@/lib/embed";

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
    expect(row!.validFrom).not.toBeNull();
    expect(row!.validUntil).toBeNull();
    // fact memories do not auto-expire
    expect(row!.expiresAt).toBeNull();
    // sourceMessageIds should be populated when passed
    createdMemoryIds.push(row!.id);
  }, 60_000);

  it("replace action sets validUntil on the target memory", async () => {
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

    // Old memory is invalidated (validUntil set, not suppressedAt)
    const [old] = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "User uses RTX 5070 Ti"));
    expect(old).toBeDefined();
    expect(old!.validUntil).not.toBeNull();
    expect(old!.suppressedAt).toBeNull();

    // New memory is inserted and active
    const [newRow] = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "User upgraded to RTX 5080"));
    expect(newRow).toBeDefined();
    expect(newRow!.validUntil).toBeNull();
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

  it("working memory gets expiresAt set and sourceMessageIds populated", async () => {
    const threadId = createdThreadIds[0];
    const llm = mockLLM(
      JSON.stringify([
        { kind: "working", content: "Currently debugging auth flow", importance: 0.6, action: "new" },
      ]),
    );

    await generateMemories(
      threadId,
      [
        { role: "user", content: "I'm debugging the auth flow" },
        { role: "assistant", content: "Good luck with the auth debugging." },
      ],
      llm,
      "test-model",
      undefined,
      ["msg-user-1", "msg-assistant-1"],
    );

    const [row] = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "Currently debugging auth flow"));
    expect(row).toBeDefined();
    expect(row!.kind).toBe("working");
    expect(row!.validFrom).not.toBeNull();
    expect(row!.expiresAt).not.toBeNull();
    expect(row!.sourceMessageIds).toEqual(["msg-user-1", "msg-assistant-1"]);
    createdMemoryIds.push(row!.id);
  }, 60_000);
});

// Multi-call mock: returns different responses per call index
function mockLLMMulti(responses: string[]): OpenAI {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          const response = responses[callIndex] ?? responses[responses.length - 1];
          callIndex++;
          return { choices: [{ message: { content: response } }] };
        }),
      },
    },
  } as unknown as OpenAI;
}

describe("generateMemories — contradiction detection", () => {
  const cThreadIds: string[] = [];
  const cMemoryIds: string[] = [];

  beforeAll(async () => {
    const [thread] = await db.insert(threads).values({ title: "contradiction test" }).returning();
    cThreadIds.push(thread.id);
  });

  afterEach(() => {
    // Restore the default hash-based embedText implementation after mockResolvedValueOnce overrides
    vi.mocked(embedText).mockImplementation(async (text: string) => {
      const hash = createHash("sha256").update(text).digest();
      return Array.from({ length: 1024 }, (_, i) => (hash[i % 32] ?? 0) / 255);
    });
  });

  afterAll(async () => {
    for (const id of cMemoryIds) {
      await db.delete(memories).where(eq(memories.id, id));
    }
    for (const id of cThreadIds) {
      await db.delete(memories).where(eq(memories.threadId, id));
      await db.delete(threads).where(eq(threads.id, id));
    }
  });

  it("invalidates old memory when new memory contradicts it", async () => {
    const threadId = cThreadIds[0];

    // Pre-insert a memory with a controlled embedding that will match the new memory
    // Use a vector of all 1s so we can make the new memory's vector identical
    const fixedVector = new Array(1024).fill(1);
    const oldContent = "User lives in Tokyo";
    const oldHash = createHash("sha256").update(oldContent).digest("hex");
    const [oldMem] = await db.insert(memories).values({
      threadId,
      kind: "fact",
      content: oldContent,
      contentHash: oldHash,
      embedding: fixedVector,
      model: "test-model",
      importance: 0.8,
      validFrom: new Date(),
    }).returning();
    cMemoryIds.push(oldMem.id);

    // Override embedText to return the same fixedVector for the new memory → sim = 1.0 > 0.75
    vi.mocked(embedText).mockResolvedValueOnce(fixedVector);

    // LLM call 1: extraction returns a contradictory new memory
    // LLM call 2: contradiction check returns "yes"
    const llm = mockLLMMulti([
      JSON.stringify([
        { kind: "fact", content: "User lives in Osaka", importance: 0.8, action: "new" },
      ]),
      "yes",
    ]);

    await generateMemories(
      threadId,
      [
        { role: "user", content: "I moved to Osaka" },
        { role: "assistant", content: "Noted your move to Osaka." },
      ],
      llm,
      "test-model",
    );

    // Old memory should have validUntil set (invalidated)
    const [oldRow] = await db.select().from(memories).where(eq(memories.id, oldMem.id));
    expect(oldRow).toBeDefined();
    expect(oldRow!.validUntil).not.toBeNull();

    // New memory should be inserted and active
    const [newRow] = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "User lives in Osaka"));
    expect(newRow).toBeDefined();
    expect(newRow!.validUntil).toBeNull();
    cMemoryIds.push(newRow!.id);
  }, 60_000);
});

describe("generateMemories — working→fact promotion", () => {
  const pThreadIds: string[] = [];
  const pMemoryIds: string[] = [];

  beforeAll(async () => {
    const [thread] = await db.insert(threads).values({ title: "promotion test" }).returning();
    pThreadIds.push(thread.id);
  });

  afterAll(async () => {
    for (const id of pMemoryIds) {
      await db.delete(memories).where(eq(memories.id, id));
    }
    for (const id of pThreadIds) {
      await db.delete(memories).where(eq(memories.threadId, id));
      await db.delete(threads).where(eq(threads.id, id));
    }
  });

  it("promotes working memory to fact when LLM says yes", async () => {
    const threadId = pThreadIds[0];

    // Pre-insert a working memory with injectionCount=3 and recent lastReferencedAt
    const content = "User is currently using FastAPI for their project";
    const embedding = await embedText(content);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const [workMem] = await db.insert(memories).values({
      threadId,
      kind: "working",
      content,
      contentHash,
      embedding,
      model: "test-model",
      importance: 0.6,
      validFrom: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      injectionCount: 3,
      lastReferencedAt: new Date(),
    }).returning();
    pMemoryIds.push(workMem.id);

    // LLM call 1: promotion check returns "yes"
    // LLM call 2: extraction returns empty array (no new memories)
    const llm = mockLLMMulti([
      "yes",
      "[]",
    ]);

    await generateMemories(
      threadId,
      [
        { role: "user", content: "Tell me about my project" },
        { role: "assistant", content: "You're using FastAPI." },
      ],
      llm,
      "test-model",
    );

    // Memory should be promoted to fact
    const [row] = await db.select().from(memories).where(eq(memories.id, workMem.id));
    expect(row).toBeDefined();
    expect(row!.kind).toBe("fact");
    expect(row!.expiresAt).toBeNull();
  }, 60_000);
});
