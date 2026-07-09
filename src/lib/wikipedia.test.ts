// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock fetch: verify success/failure without actual network access to the Wikipedia API
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { searchWikipedia } from "@/lib/wikipedia";

afterEach(() => {
  fetchMock.mockReset();
});

describe("searchWikipedia", () => {
  it("English query → fetches opensearch → summary from en.wikipedia.org and returns WikipediaResult", async () => {
    // opensearch response: [search, [titles], [descriptions], [urls]]
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ["Earth", ["Earth"], ["Planet"], ["https://en.wikipedia.org/wiki/Earth"]],
    });
    // summary response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        title: "Earth",
        description: "Third planet from the Sun",
        extract: "Earth is the third planet from the Sun.",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Earth" } },
      }),
    });

    const result = await searchWikipedia("Earth");

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Earth");
    expect(result!.description).toBe("Third planet from the Sun");
    expect(result!.extract).toBe("Earth is the third planet from the Sun.");
    expect(result!.url).toBe("https://en.wikipedia.org/wiki/Earth");
    expect(result!.lang).toBe("en");

    // opensearch is sent to en.wikipedia.org
    const opensearchCall = fetchMock.mock.calls[0];
    expect(opensearchCall[0]).toContain("en.wikipedia.org");
    expect(opensearchCall[0]).toContain("action=opensearch");
    expect(opensearchCall[0]).toContain("search=Earth");
  });

  it("Japanese query → sends request to ja.wikipedia.org (not en)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ["地球", ["地球"], [], []],
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        title: "地球",
        description: "太陽系の第3惑星",
        extract: "地球（ちきゅう）は、太陽系の第3惑星である。",
        content_urls: { desktop: { page: "https://ja.wikipedia.org/wiki/地球" } },
      }),
    });

    const result = await searchWikipedia("地球って何");

    expect(result).not.toBeNull();
    expect(result!.lang).toBe("ja");
    expect(result!.title).toBe("地球");

    // opensearch is sent to ja.wikipedia.org
    const opensearchCall = fetchMock.mock.calls[0];
    expect(opensearchCall[0]).toContain("ja.wikipedia.org");
    expect(opensearchCall[0]).not.toContain("en.wikipedia.org");
  });

  it("returns null when opensearch returns empty array (no titles)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ["nonexistentquery", [], [], []],
    });

    const result = await searchWikipedia("nonexistentquery");

    expect(result).toBeNull();
    // summary endpoint is not called (only 1 call)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when opensearch returns 404", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await searchWikipedia("anything");

    expect(result).toBeNull();
  });

  it("returns null when summary returns 404", async () => {
    // opensearch succeeds
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ["SomeTitle", ["SomeTitle"], [], []],
    });
    // summary returns 404
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await searchWikipedia("SomeTitle");

    expect(result).toBeNull();
  });

  it("returns null when opensearch fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const result = await searchWikipedia("Earth");

    expect(result).toBeNull();
  });

  it("returns null when summary fetch rejects", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ["Earth", ["Earth"], [], []],
    });
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const result = await searchWikipedia("Earth");

    expect(result).toBeNull();
  });

  it("returns null and does not fetch for empty string query", async () => {
    const result = await searchWikipedia("   ");

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to standard URL when content_urls is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ["Earth", ["Earth"], [], []],
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        title: "Earth",
        description: "",
        extract: "Earth is a planet.",
        // no content_urls
      }),
    });

    const result = await searchWikipedia("Earth");

    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://en.wikipedia.org/wiki/Earth");
  });
});
