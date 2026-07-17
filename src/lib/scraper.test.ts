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
import {
  normalizeUrl,
  scrapeUrl,
  searchWeb,
  detectSearchLanguage,
  dedupeAndRankSearchResults,
} from "@/lib/scraper";

describe("normalizeUrl", () => {
  it("normalizes http URL", () => {
    expect(normalizeUrl("http://example.com/path/")).toBe("http://example.com/path");
  });

  it("normalizes https URL", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("preserves trailing slash for root URL", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("removes fragment", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe("https://example.com/page");
  });

  it("removes trailing slash (non-root)", () => {
    expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
  });


  it("preserves query string", () => {
    expect(normalizeUrl("https://example.com/path?query=1")).toBe("https://example.com/path?query=1");
  });

  it("invalid scheme returns empty string", () => {
    expect(normalizeUrl("ftp://example.com")).toBe("");
  });

  it("javascript: returns empty string", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBe("");
  });

  it("invalid URL returns empty string", () => {
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

  it("returns ScrapeResult on success", async () => {
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

  it("throws on HTTP error", async () => {
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

  it("uses status code in message when body is not JSON on HTTP error", async () => {
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

  it("returns null early when SCRAPER_URL is empty", async () => {
    vi.stubEnv("SCRAPER_URL", "");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "", title: "", content: "", status: 200 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await scrapeUrl("https://example.com");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("searchWeb empty SCRAPER_URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns empty results early when SCRAPER_URL is empty", async () => {
    vi.stubEnv("SCRAPER_URL", "");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: "test", results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchWeb("test", 5);
    expect(result).toEqual({ query: "test", results: [] });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("returns WebSearchResponse on success", async () => {
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
        body: JSON.stringify({
          query: "python",
          max_results: 5,
          time_range: null,
          language: null,
          categories: null,
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("throws on HTTP error", async () => {
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

  it("uses status code in message when body is not JSON on HTTP error", async () => {
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

  it("default maxResults is 5", async () => {
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

describe("detectSearchLanguage", () => {
  it("returns ja-JP for Japanese queries", () => {
    expect(detectSearchLanguage("AI ニュース 2026年7月")).toBe("ja-JP");
    expect(detectSearchLanguage("Project Motor Racing 評価")).toBe("ja-JP");
  });

  it("returns en-US for English/ASCII queries", () => {
    expect(detectSearchLanguage("AI news July 2026")).toBe("en-US");
    expect(detectSearchLanguage('"PMR 2.0" review site:store.steampowered.com')).toBe("en-US");
  });
});

describe("dedupeAndRankSearchResults", () => {
  it("dedupes by normalized URL and keeps higher score", () => {
    const ranked = dedupeAndRankSearchResults([
      { url: "https://example.com/a/", title: "low", score: 1, scraped: false, content: "" },
      { url: "https://example.com/a", title: "high", score: 9, scraped: false, content: "" },
      { url: "https://example.com/b", title: "mid", score: 5, scraped: false, content: "" },
    ]);
    expect(ranked.map((r) => r.title)).toEqual(["high", "mid"]);
    expect(ranked[0].score).toBe(9);
  });

  it("on equal score prefers scraped content", () => {
    const ranked = dedupeAndRankSearchResults([
      { url: "https://example.com/x", score: 3, scraped: false, content: "" },
      { url: "https://example.com/x", score: 3, scraped: true, content: "body" },
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].scraped).toBe(true);
    expect(ranked[0].content).toBe("body");
  });

  it("drops empty urls and sorts descending by score", () => {
    const ranked = dedupeAndRankSearchResults([
      { url: "", score: 100 },
      { url: "https://example.com/low", score: 1 },
      { url: "https://example.com/high", score: 10 },
    ]);
    expect(ranked.map((r) => r.url)).toEqual([
      "https://example.com/high",
      "https://example.com/low",
    ]);
  });
});
