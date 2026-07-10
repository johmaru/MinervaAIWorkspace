// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
import { createHash } from "node:crypto";
import { db } from "@/db";
import { pages, pageEmbeddings, memories, threads } from "@/db/schema";
import { eq } from "drizzle-orm";

// Mock embedText: instead of relying on the real embedder, use bag-of-characters
// to assign similar vectors to similar content. If the search query and content
// share characters, cosine similarity will be high.
vi.mock("@/lib/embed", () => ({
  embedText: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(1024).fill(0);
    for (const ch of text) {
      vec[ch.charCodeAt(0) % 1024] = 1;
    }
    return vec;
  }),
  hashContent: vi.fn().mockImplementation((text: string) => {
    return createHash("sha256").update(text).digest("hex");
  }),
}));

import { embedText, hashContent } from "@/lib/embed";
import { POST } from "@/app/api/search/route";

// Integration test for page search. Inserts pages + page_embeddings beforehand,
// then verifies that /api/search returns the pages field.

const createdPageIds: string[] = [];

async function insertPage(
  url: string,
  title: string,
  content: string,
): Promise<string> {
  const urlHash = hashContent(url);
  const contentHash = hashContent(content);
  const [page] = await db
    .insert(pages)
    .values({ url, urlHash, title, content, contentHash, status: 200 })
    .returning();
  createdPageIds.push(page.id);

  const vector = await embedText(content, "document");
  if (vector.length > 0) {
    await db.insert(pageEmbeddings).values({
      pageId: page.id,
      contentHash,
      embedding: vector,
      model: "Xenova/all-MiniLM-L6-v2",
    });
  }
  return page.id;
}

async function searchReq(query: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/search", {
      method: "POST",
      body: JSON.stringify({ query }),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("POST /api/search", () => {
  it("empty query returns empty results", async () => {
    const res = await searchReq("");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toEqual([]);
  });

  it("includes pages field in response", async () => {
    const res = await searchReq("anything");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.pages)).toBe(true);
  });
});

describe("POST /api/search — page search", () => {
  beforeAll(async () => {
    await insertPage(
      "https://search-test.example.com",
      "Search Test Page",
      "Python is a programming language for data science and machine learning.",
    );
  });

  afterAll(async () => {
    for (const id of createdPageIds) {
      await db.delete(pageEmbeddings).where(eq(pageEmbeddings.pageId, id));
      await db.delete(pages).where(eq(pages.id, id));
    }
  });

  it("related query hits a page", async () => {
    const res = await searchReq("python programming");
    const data = await res.json();
    expect(data.pages.length).toBeGreaterThan(0);
    const hit = data.pages.find(
      (p: { url: string }) => p.url === "https://search-test.example.com",
    );
    expect(hit).toBeTruthy();
    expect(hit.title).toBe("Search Test Page");
    expect(hit.similarity).toBeGreaterThan(0.3);
    expect(hit.pageId).toBeTruthy();
  }, 60_000);
});

describe("POST /api/search — memory search", () => {
  const createdThreadIds: string[] = [];
  const createdMemoryIds: string[] = [];

  beforeAll(async () => {
    const [thread] = await db.insert(threads).values({ title: "Memory Search Test", userId: "test-user-id" }).returning();
    createdThreadIds.push(thread.id);

    const content = "ユーザーは FPGA と低レイヤー開発を得意としている";
    const vector = await embedText(content, "document");
    if (vector.length > 0) {
      const [mem] = await db
        .insert(memories)
        .values({
          threadId: thread.id,
          kind: "fact",
          content,
          contentHash: hashContent(content),
          embedding: vector,
          model: "test-model",
          validFrom: new Date(),
        })
        .returning();
      createdMemoryIds.push(mem.id);
    }
  });

  afterAll(async () => {
    for (const id of createdMemoryIds) {
      await db.delete(memories).where(eq(memories.id, id));
    }
    for (const id of createdThreadIds) {
      await db.delete(threads).where(eq(threads.id, id));
    }
  });

  it("related query hits a memory", async () => {
    const res = await searchReq("FPGA 低レイヤー");
    const data = await res.json();
    expect(data.results.length).toBeGreaterThan(0);
    const hit = data.results.find(
      (r: { threadId: string }) => r.threadId === createdThreadIds[0],
    );
    expect(hit).toBeTruthy();
    expect(hit.kind).toBe("fact");
    expect(hit.memoryId).toBeTruthy();
    expect(hit.similarity).toBeGreaterThan(0.3);
  }, 60_000);
});
