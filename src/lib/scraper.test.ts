// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => []) })) })),
  },
}));
vi.mock("@/db/schema", () => ({ pages: {} }));
vi.mock("@/lib/pageStore", () => ({ upsertPage: vi.fn().mockResolvedValue("id") }));
vi.mock("@/lib/embed", () => ({ hashContent: vi.fn().mockReturnValue("hash") }));
import { normalizeUrl, scrapeUrl, searchWeb } from "@/lib/scraper";

describe("normalizeUrl", () => {
  it("http URL を正規化", () => {
    expect(normalizeUrl("http://example.com/path/")).toBe("http://example.com/path");
  });

  it("https URL を正規化", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("ルート URL の末尾スラッシュは保持", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("fragment を削除", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe("https://example.com/page");
  });

  it("末尾スラッシュを削除（ルート以外）", () => {
    expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
  });


  it("クエリ文字列は保持", () => {
    expect(normalizeUrl("https://example.com/path?query=1")).toBe("https://example.com/path?query=1");
  });

  it("無効 scheme は空文字", () => {
    expect(normalizeUrl("ftp://example.com")).toBe("");
  });

  it("javascript: は空文字", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBe("");
  });

  it("無効URLは空文字", () => {
    expect(normalizeUrl("not a url")).toBe("");
    expect(normalizeUrl("")).toBe("");
  });
});

describe("scrapeUrl", () => {
  beforeEach(() => {
    vi.stubEnv("SCRAPER_URL", "http://localhost:8000");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("成功時 ScrapeResult を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://example.com",
        title: "Example",
        content: "body text",
        status: 200,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await scrapeUrl("https://example.com");
    expect(result).toEqual({
      url: "https://example.com",
      title: "Example",
      content: "body text",
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/scrape",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      }),
    );
  });

  it("HTTP エラー時は例外を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: "fetch failed: timeout" }),
      }),
    );
    await expect(scrapeUrl("https://example.com")).rejects.toThrow("fetch failed: timeout");
  });

  it("HTTP エラーで body が JSON でない場合はステータスをメッセージに", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("invalid json");
        },
      }),
    );
    await expect(scrapeUrl("https://example.com")).rejects.toThrow("HTTP 500");
  });

  it("SCRAPER_URL env が未設定時は localhost:8000 を使う", async () => {
    vi.stubEnv("SCRAPER_URL", "");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: "", title: "", content: "", status: 200 }),
      }),
    );
    await scrapeUrl("https://example.com");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://localhost:8000/scrape",
      expect.anything(),
    );
  });
});

describe("searchWeb", () => {
  beforeEach(() => {
    vi.stubEnv("SCRAPER_URL", "http://localhost:8000");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("成功時 WebSearchResponse を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        query: "python",
        results: [
          {
            url: "https://example.com/python",
            title: "Python",
            snippet: "Python is a language",
            scraped: true,
            content: "body text",
            scrape_title: "Python",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchWeb("python", 5);
    expect(result.query).toBe("python");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://example.com/python");
    expect(result.results[0].scraped).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/search",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "python", max_results: 5 }),
      }),
    );
  });

  it("HTTP エラー時は例外を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({ error: "search failed: timeout" }),
      }),
    );
    await expect(searchWeb("python")).rejects.toThrow("search failed: timeout");
  });

  it("HTTP エラーで body が JSON でない場合はステータスをメッセージに", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("invalid json");
        },
      }),
    );
    await expect(searchWeb("python")).rejects.toThrow("HTTP 500");
  });

  it("デフォルト maxResults は 5", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: "x", results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await searchWeb("test");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_results).toBe(5);
  });
});
