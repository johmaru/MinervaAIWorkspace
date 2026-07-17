// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  applyDomainQualityFilter,
  extractHeuristicKeywords,
  formatSearchResultsForContext,
  hostnameOf,
  isLowQualityHost,
  isThinSearchResults,
  parseSearchCategory,
  rewriteQueryForRetry,
  sliceContentAroundQuery,
} from "@/lib/searchQuality";

describe("hostnameOf / isLowQualityHost", () => {
  it("strips www and lowercases", () => {
    expect(hostnameOf("https://www.Example.com/path")).toBe("example.com");
  });

  it("flags known low-quality hosts", () => {
    expect(isLowQualityHost("pinterest.com")).toBe(true);
    expect(isLowQualityHost("quora.com")).toBe(true);
    expect(isLowQualityHost("github.com")).toBe(false);
  });
});

describe("applyDomainQualityFilter", () => {
  it("drops hard low-quality hosts and caps per domain", () => {
    const out = applyDomainQualityFilter(
      [
        { url: "https://pinterest.com/a", score: 100, title: "pin" },
        { url: "https://example.com/1", score: 10, title: "e1" },
        { url: "https://example.com/2", score: 9, title: "e2" },
        { url: "https://example.com/3", score: 8, title: "e3" },
        { url: "https://other.com/x", score: 7, title: "o" },
      ],
      2,
    );
    expect(out.every((r) => !r.url.includes("pinterest"))).toBe(true);
    expect(out.filter((r) => hostnameOf(r.url) === "example.com")).toHaveLength(2);
    expect(out.some((r) => hostnameOf(r.url) === "other.com")).toBe(true);
  });

  it("soft-demotes medium hosts so higher-score clean hosts win", () => {
    const out = applyDomainQualityFilter([
      { url: "https://medium.com/post", score: 10, title: "m" },
      { url: "https://docs.example.com/api", score: 6, title: "docs" },
    ]);
    // medium score becomes 4, docs stays 6 → docs first
    expect(out[0].title).toBe("docs");
  });
});

describe("sliceContentAroundQuery", () => {
  it("returns full content when short enough", () => {
    expect(sliceContentAroundQuery("hello world", "hello", 100)).toBe("hello world");
  });

  it("centers window on query term hit", () => {
    const prefix = "a".repeat(500);
    const hit = "IMPORTANT_KEYWORD appears here with context";
    const suffix = "b".repeat(2000);
    const content = prefix + hit + suffix;
    const sliced = sliceContentAroundQuery(content, "IMPORTANT_KEYWORD", 200);
    expect(sliced).toContain("IMPORTANT_KEYWORD");
    expect(sliced.length).toBeLessThanOrEqual(202); // ellipsis may add 1–2 chars
  });

  it("falls back to head when no term matches", () => {
    const content = "x".repeat(3000);
    const sliced = sliceContentAroundQuery(content, "zzzz", 100);
    expect(sliced).toBe("x".repeat(100));
  });
});

describe("isThinSearchResults", () => {
  it("true for empty", () => {
    expect(isThinSearchResults([])).toBe(true);
  });

  it("true when only tiny snippets", () => {
    expect(
      isThinSearchResults([{ title: "t", snippet: "hi", content: "", scraped: false }]),
    ).toBe(true);
  });

  it("false when scraped body is substantial", () => {
    expect(
      isThinSearchResults([
        {
          title: "t",
          snippet: "short",
          content: "x".repeat(50),
          scraped: true,
        },
      ]),
    ).toBe(false);
  });
});

describe("rewriteQueryForRetry", () => {
  it("strips site: and quotes", () => {
    expect(rewriteQueryForRetry('"PMR 2.0" review site:store.steampowered.com')).toBe(
      "PMR 2.0 review",
    );
  });
});

describe("extractHeuristicKeywords", () => {
  it("strips Japanese filler and keeps product tokens", () => {
    const kw = extractHeuristicKeywords(
      "Project Motor Racing 2.0のSteamでの評価はどうなってる？最新のレビュー状況を教えて",
    );
    expect(kw).toContain("Project");
    expect(kw).toMatch(/Motor|Racing|2\.0|Steam|評価|レビュー/);
    expect(kw).not.toContain("教えて");
  });

  it("keeps English keywords", () => {
    const kw = extractHeuristicKeywords("What is the latest price of Bun runtime?");
    expect(kw.toLowerCase()).toMatch(/latest|price|bun|runtime/);
    expect(kw.toLowerCase()).not.toContain("what");
  });
});

describe("formatSearchResultsForContext", () => {
  it("shrinks content budget when many results", () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `T${i}`,
      snippet: "s".repeat(50),
      content: "c".repeat(3000),
    }));
    const json = formatSearchResultsForContext(results);
    const parsed = JSON.parse(json) as Array<{ content: string }>;
    expect(parsed).toHaveLength(8);
    // budget for n>6 is 500
    expect(parsed.every((r) => r.content.length <= 500)).toBe(true);
  });
});

describe("parseSearchCategory", () => {
  it("accepts known categories and nulls the rest", () => {
    expect(parseSearchCategory("news")).toBe("news");
    expect(parseSearchCategory("science")).toBe("science");
    expect(parseSearchCategory("it")).toBe("it");
    expect(parseSearchCategory("general")).toBe("general");
    expect(parseSearchCategory("images")).toBeNull();
    expect(parseSearchCategory(undefined)).toBeNull();
  });
});
