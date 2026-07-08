// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { pages, pageEmbeddings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashContent } from "@/lib/embed";
import { upsertPage } from "@/lib/pageStore";

// Mock embedText to avoid external embedder/transformers.js dependency.
// hashContent stays real (deterministic SHA-256) so assertions are not weakened.
vi.mock("@/lib/embed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed")>();
  return { ...actual, embedText: vi.fn(async () => [0.1, 0.2, 0.3]) };
});

// Test URLs (dummy domains to avoid collisions with real ones)
const URL_NEW = "https://pagestore-test-new.example";
const URL_CACHE = "https://pagestore-test-cache.example";
const URL_UPDATE = "https://pagestore-test-update.example";

const testUrlHashes = [
  hashContent(URL_NEW),
  hashContent(URL_CACHE),
  hashContent(URL_UPDATE),
];
const createdPageIds: string[] = [];

async function cleanupByHashes() {
  for (const h of testUrlHashes) {
    const rows = await db.select({ id: pages.id }).from(pages).where(eq(pages.urlHash, h));
    for (const r of rows) {
      await db.delete(pageEmbeddings).where(eq(pageEmbeddings.pageId, r.id));
      await db.delete(pages).where(eq(pages.id, r.id));
    }
  }
}

beforeAll(async () => {
  await cleanupByHashes();
});

afterAll(async () => {
  for (const id of createdPageIds) {
    await db.delete(pageEmbeddings).where(eq(pageEmbeddings.pageId, id));
    await db.delete(pages).where(eq(pages.id, id));
  }
  await cleanupByHashes();
});

describe("upsertPage", () => {
  it("inserts a new URL and returns its id", async () => {
    const id = await upsertPage(URL_NEW, "New Page", "fresh content for new page");
    expect(id).toBeTruthy();
    createdPageIds.push(id);

    const [row] = await db.select().from(pages).where(eq(pages.id, id));
    expect(row).toBeDefined();
    expect(row!.url).toBe(URL_NEW);
    expect(row!.title).toBe("New Page");
    expect(row!.content).toBe("fresh content for new page");

    // page_embeddings is also generated
    const [emb] = await db
      .select()
      .from(pageEmbeddings)
      .where(eq(pageEmbeddings.pageId, id));
    expect(emb).toBeDefined();
    expect(emb!.contentHash).toBe(hashContent("fresh content for new page"));
  });

  it("same URL with same content is a cache hit (no re-embed)", async () => {
    const id1 = await upsertPage(URL_CACHE, "Cache", "cached content");
    createdPageIds.push(id1);
    const id2 = await upsertPage(URL_CACHE, "Cache", "cached content");

    // Returns the same id (re-embed skipped)
    expect(id2).toBe(id1);
  });

  it("same URL with changed content triggers upsert + re-embed", async () => {
    const id1 = await upsertPage(URL_UPDATE, "V1", "version one");
    createdPageIds.push(id1);

    // Content changed
    const id2 = await upsertPage(URL_UPDATE, "V2", "version two");
    expect(id2).toBe(id1); // Same id (update)

    const [row] = await db.select().from(pages).where(eq(pages.id, id1));
    expect(row!.title).toBe("V2");
    expect(row!.content).toBe("version two");
    expect(row!.contentHash).toBe(hashContent("version two"));

    // page_embeddings is also updated
    const [emb] = await db
      .select()
      .from(pageEmbeddings)
      .where(eq(pageEmbeddings.pageId, id1));
    expect(emb!.contentHash).toBe(hashContent("version two"));
  });
});
