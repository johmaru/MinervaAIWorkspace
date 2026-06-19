// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { pages, pageEmbeddings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { embedText, hashContent } from "@/lib/embed";
import { POST } from "@/app/api/search/route";

// ページ検索の統合テスト。事前に pages + page_embeddings を挿入し、
// /api/search が pages フィールドを返すことを検証。

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
  it("空クエリは空 results を返す", async () => {
    const res = await searchReq("");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toEqual([]);
  });

  it("pages フィールドが含まれる", async () => {
    const res = await searchReq("anything");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.pages)).toBe(true);
  });
});

describe("POST /api/search — ページ検索", () => {
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

  it("関連クエリでページがヒットする", async () => {
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
