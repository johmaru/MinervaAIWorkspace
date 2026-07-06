// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// fetch をモック: Wikipedia API への実際のネットワークアクセスなしで成功/失敗を検証
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { searchWikipedia } from "@/lib/wikipedia";

afterEach(() => {
  fetchMock.mockReset();
});

describe("searchWikipedia", () => {
  it("英語クエリ → en.wikipedia.org で opensearch → summary を取得し WikipediaResult を返す", async () => {
    // opensearch レスポンス: [search, [titles], [descriptions], [urls]]
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ["Earth", ["Earth"], ["Planet"], ["https://en.wikipedia.org/wiki/Earth"]],
    });
    // summary レスポンス
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

    // opensearch は en.wikipedia.org に送信
    const opensearchCall = fetchMock.mock.calls[0];
    expect(opensearchCall[0]).toContain("en.wikipedia.org");
    expect(opensearchCall[0]).toContain("action=opensearch");
    expect(opensearchCall[0]).toContain("search=Earth");
  });

  it("日本語クエリ → ja.wikipedia.org にリクエストする（en ではない）", async () => {
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

    // opensearch は ja.wikipedia.org に送信
    const opensearchCall = fetchMock.mock.calls[0];
    expect(opensearchCall[0]).toContain("ja.wikipedia.org");
    expect(opensearchCall[0]).not.toContain("en.wikipedia.org");
  });

  it("opensearch が空配列（タイトルなし）→ null を返す", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ["nonexistentquery", [], [], []],
    });

    const result = await searchWikipedia("nonexistentquery");

    expect(result).toBeNull();
    // summary endpoint は呼ばれない（1回のみ）
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opensearch が 404 → null を返す", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await searchWikipedia("anything");

    expect(result).toBeNull();
  });

  it("summary が 404 → null を返す", async () => {
    // opensearch は成功
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ["SomeTitle", ["SomeTitle"], [], []],
    });
    // summary は 404
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await searchWikipedia("SomeTitle");

    expect(result).toBeNull();
  });

  it("opensearch の fetch が reject した場合 → null を返す", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const result = await searchWikipedia("Earth");

    expect(result).toBeNull();
  });

  it("summary の fetch が reject した場合 → null を返す", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ["Earth", ["Earth"], [], []],
    });
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const result = await searchWikipedia("Earth");

    expect(result).toBeNull();
  });

  it("空文字クエリ → null を返し fetch しない", async () => {
    const result = await searchWikipedia("   ");

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("content_urls が無い場合は標準 URL をフォールバック先として使う", async () => {
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
        // content_urls 無し
      }),
    });

    const result = await searchWikipedia("Earth");

    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://en.wikipedia.org/wiki/Earth");
  });
});
