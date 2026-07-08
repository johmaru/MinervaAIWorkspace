// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
import { db } from "@/db";
import { pages, pageEmbeddings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashContent } from "@/lib/embed";
import { POST } from "@/app/api/scrape/route";

// scrapeUrl をモック: 実 microservice を叩かない
vi.mock("@/lib/scraper", () => ({
  scrapeUrl: vi.fn(),
  normalizeUrl: (u: string) => {
    try {
      const url = new URL(u);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      url.hash = "";
      let s = url.toString();
      if (s.endsWith("/") && s !== `${url.origin}/`) s = s.slice(0, -1);
      return s;
    } catch {
      return "";
    }
  },
}));

import { scrapeUrl } from "@/lib/scraper";

// テスト用 URL（実在しないダミードメインで衝突回避）
const URL_NEW = "https://scrape-test-new.example";
const URL_CACHE = "https://scrape-test-cache.example";
const URL_UPDATE = "https://scrape-test-update.example";
const URL_FAIL = "https://scrape-test-fail.example";

const testUrlHashes = [
  hashContent(URL_NEW),
  hashContent(URL_CACHE),
  hashContent(URL_UPDATE),
  hashContent(URL_FAIL),
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
  // 前回テスト中断時の残骸を除去
  await cleanupByHashes();
});

afterAll(async () => {
  for (const id of createdPageIds) {
    await db.delete(pageEmbeddings).where(eq(pageEmbeddings.pageId, id));
    await db.delete(pages).where(eq(pages.id, id));
  }
  await cleanupByHashes();
});

function scrapeReq(url: string): Request {
  return new Request("http://localhost/api/scrape", {
    method: "POST",
    body: JSON.stringify({ url }),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/scrape — バリデーション", () => {
  it("空ボディは 400", async () => {
    const res = await POST(new Request("http://localhost/api/scrape", { method: "POST" }));
    expect(res.status).toBe(400);
  });

  it("不正 JSON は 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/scrape", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("url 未指定は 400", async () => {
    const res = await POST(scrapeReq(""));
    expect(res.status).toBe(400);
  });

  it("無効 scheme は 400", async () => {
    const res = await POST(scrapeReq("ftp://example.com"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/scrape — 統合", () => {
  it("新規URLをスクレイプして保存", async () => {
    vi.mocked(scrapeUrl).mockResolvedValueOnce({
      url: URL_NEW,
      title: "Example Domain",
      content: "This is example content for testing.",
      status: 200,
    });

    const res = await POST(scrapeReq(URL_NEW));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cached).toBe(false);
    expect(data.title).toBe("Example Domain");
    expect(data.url).toBe(URL_NEW);
    expect(data.contentPreview).toBe("This is example content for testing.");
    expect(data.id).toBeTruthy();
    createdPageIds.push(data.id);
  });

  it("同一URL再送で cached: true", async () => {
    // 1回目: 新規
    vi.mocked(scrapeUrl).mockResolvedValueOnce({
      url: URL_CACHE,
      title: "Cache Test",
      content: "same content",
      status: 200,
    });
    const res1 = await POST(scrapeReq(URL_CACHE));
    const data1 = await res1.json();
    createdPageIds.push(data1.id);

    // 2回目: contentHash 同じ → cached
    vi.mocked(scrapeUrl).mockResolvedValueOnce({
      url: URL_CACHE,
      title: "Cache Test",
      content: "same content",
      status: 200,
    });
    const res2 = await POST(scrapeReq(URL_CACHE));
    const data2 = await res2.json();
    expect(data2.cached).toBe(true);
    expect(data2.id).toBe(data1.id);
  });

  it("内容が変わったら再 embed", async () => {
    // 1回目
    vi.mocked(scrapeUrl).mockResolvedValueOnce({
      url: URL_UPDATE,
      title: "V1",
      content: "version one",
      status: 200,
    });
    const res1 = await POST(scrapeReq(URL_UPDATE));
    const data1 = await res1.json();
    createdPageIds.push(data1.id);

    // 2回目: content 変更
    vi.mocked(scrapeUrl).mockResolvedValueOnce({
      url: URL_UPDATE,
      title: "V2",
      content: "version two",
      status: 200,
    });
    const res2 = await POST(scrapeReq(URL_UPDATE));
    const data2 = await res2.json();
    expect(data2.cached).toBe(false);
    expect(data2.title).toBe("V2");
  });

  it("スクレイプ失敗時は 502", async () => {
    vi.mocked(scrapeUrl).mockRejectedValueOnce(new Error("microservice down"));
    const res = await POST(scrapeReq(URL_FAIL));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toContain("microservice down");
  });
});
