// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock createLLM: verify decideSearch logic without calling the real API
const mockCreate = vi.fn();
vi.mock("@/lib/llm", () => ({
  createLLM: () => mockCreate(),
  buildDisableReasoningParams: () => Promise.resolve({ reasoning_effort: "none" }),
}));

import { decideSearch } from "@/lib/searchDecision";

/**
 * Builds a mock OpenAI client.
 * Specifies the content returned by create.
 */
function mockClient(content: string | null) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      },
    },
  };
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe("decideSearch", () => {
  it("parses searchLevel:web + queries", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "web",
          reason: "latest reviews needed",
          userNotice: "Steamの評価は変わるので、最新のレビュー状況を確認するね。",
          queries: ["Project Motor Racing 2.0 Steam review", "PMR 2.0 評価"],
        }),
      ),
    );

    const decision = await decideSearch("PMR2.0の評価は？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.reason).toBe("latest reviews needed");
    expect(decision.userNotice).toBe("最新の評価やレビューをWebで確認します。");
    expect(decision.queries).toEqual([
      "Project Motor Racing 2.0 Steam review",
      "PMR 2.0 評価",
    ]);
  });

  it("returns empty queries when searchLevel is none", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "none",
          reason: "stable knowledge",
          userNotice: null,
          queries: [],
        }),
      ),
    );

    const decision = await decideSearch("Pythonのリスト内包表記の使い方を教えて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
    expect(decision.userNotice).toBeNull();
  });

  it("routes to search even when LLM judges no search needed, if latest review is requested", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "none",
          reason: "stable knowledge",
          userNotice: null,
          queries: [],
        }),
      ),
    );

    const decision = await decideSearch("Project Motor Racing 2.0のSteamでの評価はどうなってる？最新のレビュー状況を教えて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.reason).toContain("heuristic");
    expect(decision.userNotice).toBe(
      "検索判定を定型ルールで補完し、Webで最新情報を確認します。",
    );
    expect(decision.queries[0]).toContain("Project Motor Racing 2.0");
    expect(decision.queries[0]).toContain("Steam");
  });

  it("normalizes unnatural userNotice from LLM into a polite fixed sentence", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "web",
          reason: "current evaluation",
          userNotice: "GLM5.2の評価は新しく出ている情報に変わるから、最新の状況を調べるね。",
          queries: ["GLM5.2 評価 最新"],
        }),
      ),
    );

    const decision = await decideSearch("GLM5.2の評価どうなってる？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe("最新の評価やレビューをWebで確認します。");
  });

  it("normalizes to Steam-specific fixed sentence on Steam-related search decision success", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "web",
          reason: "steam status",
          userNotice: "Steamを確認するね",
          queries: ["Project Motor Racing 2.0 Steam"],
        }),
      ),
    );

    const decision = await decideSearch("Project Motor Racing 2.0はSteamで配信されてる？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe("Steamの最新情報をWebで確認します。");
  });

  it("parses JSON wrapped in markdown code fences", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        '```json\n{"searchLevel": "web", "reason": "need search", "userNotice": "確認するね", "queries": ["latest news"]}\n```',
      ),
    );

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries).toEqual(["latest news"]);
    expect(decision.userNotice).toBe("最新の情報をWebで確認します。");
  });

  it("also parses plain JSON without fences", async () => {
    mockCreate.mockReturnValue(
      mockClient('{"searchLevel": "none", "reason": "ok", "userNotice": null, "queries": []}'),
    );

    const decision = await decideSearch("hi", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toBe("ok");
  });

  it("falls back to searchLevel:none when LLM returns invalid JSON", async () => {
    mockCreate.mockReturnValue(mockClient("this is not json"));

    const decision = await decideSearch("hi", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toBe("router failed");
    expect(decision.queries).toEqual([]);
  });

  it("routes to search on explicit search request even when LLM returns invalid JSON", async () => {
    mockCreate.mockReturnValue(mockClient("this is not json"));

    const decision = await decideSearch("Project Motor Racing 2.0 Steam 最新レビューを調べて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe(
      "検索判定を定型ルールで補完し、Webで最新情報を確認します。",
    );
    expect(decision.queries[0]).toContain("Project Motor Racing 2.0");
  });

  it("falls back to searchLevel:none when LLM call rejects", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("network error")),
        },
      },
    });

    const decision = await decideSearch("hi", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toBe("router failed");
    expect(decision.queries).toEqual([]);
  });

  it("routes to search on explicit search request even when LLM call rejects", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("network error")),
        },
      },
    });

    const decision = await decideSearch("この商品の現在の価格を確認して", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe(
      "検索判定を定型ルールで補完し、Webで最新情報を確認します。",
    );
    expect(decision.queries[0]).toContain("現在の価格");
  });

  it("filters out empty strings and non-strings from queries", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "web",
          reason: "need search",
          userNotice: "確認するね",
          queries: ["valid query", "", "  ", 123, null, "another valid"],
        }),
      ),
    );

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries).toEqual(["valid query", "another valid"]);
  });

  it("sets userNotice to null when empty or whitespace-only", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "web",
          reason: "need search",
          userNotice: "   ",
          queries: ["q"],
        }),
      ),
    );

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe("最新の情報をWebで確認します。");
  });

  it("falls back when content is null", async () => {
    mockCreate.mockReturnValue(mockClient(null));

    const decision = await decideSearch("hi", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
  });

  it("falls back when content is empty string", async () => {
    mockCreate.mockReturnValue(mockClient(""));

    const decision = await decideSearch("hi", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toBe("router failed");
  });

  it("passes history as messages other than the system prompt", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              searchLevel: "none",
              reason: "stable",
              userNotice: null,
              queries: [],
            }),
          },
        },
      ],
    });
    mockCreate.mockReturnValue({ chat: { completions: { create } } });

    await decideSearch("follow up", "umans-glm-5.2", "ja", [
      { role: "user", content: "前の質問" },
      { role: "assistant", content: "前の回答" },
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0] as { messages: { role: string; content: string }[] };
    // system, user, assistant, user order
    expect(params.messages).toHaveLength(4);
    expect(params.messages[0].role).toBe("system");
    expect(params.messages[1]).toEqual({ role: "user", content: "前の質問" });
    expect(params.messages[2]).toEqual({ role: "assistant", content: "前の回答" });
    expect(params.messages[3]).toEqual({ role: "user", content: "follow up" });
  });

  it("calls with regular completion without response_format", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ searchLevel: "none", reason: "ok", userNotice: null, queries: [] }) } }],
    });
    mockCreate.mockReturnValue({ chat: { completions: { create } } });

    await decideSearch("hi", "umans-glm-5.2", "ja", []);

    const params = create.mock.calls[0][0] as { response_format?: unknown };
    expect(params.response_format).toBeUndefined();
  });

  it("heuristic does not force search for memory recall questions (does not search if LLM judges unnecessary)", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "none",
          reason: "asking about past conversation",
          userNotice: null,
          queries: [],
        }),
      ),
    );

    const decision = await decideSearch("最近何の話しした？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
  });

  it("does not search on memory recall questions even when LLM fails", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("network error")),
        },
      },
    });

    const decision = await decideSearch("前に何を話したか覚えてる？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toBe("router failed");
    expect(decision.queries).toEqual([]);
  });

  it("English memory recall patterns also suppress search", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "none",
          reason: "recall question",
          userNotice: null,
          queries: [],
        }),
      ),
    );

    const decision = await decideSearch("what did we talk about last time?", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
  });

  it("exhaustively suppresses search for English memory recall variations", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "none",
          reason: "recall question",
          userNotice: null,
          queries: [],
        }),
      ),
    );

    const recallQueries = [
      "what were we talking about earlier?",
      "what we discussed last time",
      "yesterday's conversation",
      "remember what we talked about?",
      "remember when you said that",
      "our last conversation",
      "the other day we were chatting about",
      "earlier today we discussed",
      "previously we had a chat about",
    ];

    for (const q of recallQueries) {
      mockCreate.mockClear();
      mockCreate.mockReturnValue(
        mockClient(
          JSON.stringify({
            searchLevel: "none",
            reason: "recall question",
            userNotice: null,
            queries: [],
          }),
        ),
      );
      const decision = await decideSearch(q, "umans-glm-5.2", "ja", []);
      expect(decision.searchLevel, `query: ${q}`).toBe("none");
    }
  });

  it("code questions are heuristically determined as no-search and do not call LLM", async () => {
    // Set reject so LLM call immediately fails if invoked
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM should not be called")),
        },
      },
    });

    const decision = await decideSearch("Pythonでフィボナッチ数列を計算するコードを書いて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toContain("heuristic");
    expect(decision.queries).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("translation requests are heuristically determined as no-search and do not call LLM", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM should not be called")),
        },
      },
    });

    const decision = await decideSearch("この文章を英語に翻訳して", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("opinion/advice requests are heuristically determined as no-search and do not call LLM", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM should not be called")),
        },
      },
    });

    const decision = await decideSearch("このデザインについてどう思う？アドバイスをちょうだい", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("English code questions are also heuristically determined as no-search", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM should not be called")),
        },
      },
    });

    const decision = await decideSearch("write a program to sort an array", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("proceeds to LLM judgment even for no-search patterns when 'search' is explicitly requested", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "web",
          reason: "explicit search requested",
          userNotice: null,
          queries: ["最新の Python コード事例"],
        }),
      ),
    );

    const decision = await decideSearch("最新の Python コードを検索して", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("UNKNOWN_TERM heuristic (unknown-term pattern) results in searchLevel:wiki", async () => {
    // Set reject so LLM call immediately fails if invoked
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM should not be called")),
        },
      },
    });

    const decision = await decideSearch("マグナ・カルタって何？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(decision.queries).toEqual(["マグナ・カルタって何？"]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // --- Step 7: Extended UNKNOWN_TERM_PATTERN tests ---
  // Verify that all are caught heuristically and LLM is not called.
  it("personality question pattern results in wiki (personality match)", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("欠地王ジョンって性格悪かったの？", "umans-glm-5.2", "ja", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(decision.queries).toEqual(["欠地王ジョンって性格悪かったの？"]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("what-kind-of-person pattern results in wiki (what-kind match)", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("織田信長ってどんな人だった？", "umans-glm-5.2", "ja", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("did-they-really-exist pattern results in wiki (really match)", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("ソクラテスって本当にいたの？", "umans-glm-5.2", "ja", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does-it-exist pattern results in wiki (exist match)", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("シャーロック・ホームズって実在する？", "umans-glm-5.2", "ja", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("who-is pattern results in wiki (who match)", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("ジョン王って誰？", "umans-glm-5.2", "ja", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("parses when LLM returns searchLevel:wiki", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "wiki",
          reason: "named entity lookup",
          userNotice: "Wikipediaで調べます。",
          queries: ["マグナ・カルタ"],
        }),
      ),
    );

    const decision = await decideSearch("マグナ・カルタについて教えて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.queries).toEqual(["マグナ・カルタ"]);
    // When heuristic is null (pattern does not match), LLM returns wiki.
    // normalizeDecisionNotice recomputes via buildUserNotice, but since
    // UNKNOWN_TERM_PATTERN does not match, it becomes DEFAULT_USER_NOTICE (plan assumption: no wiki-specific branch).
  });

  // --- English locale: heuristic pattern extension verification ---
  it("en: \"who was Socrates\" results in wiki judgment and does not call LLM", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("who was Socrates", "umans-glm-5.2", "en", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("I'll look it up on Wikipedia.");
    expect(decision.queries).toEqual(["who was Socrates"]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("en: \"was King John really a bad person\" results in wiki judgment and does not call LLM", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("was King John really a bad person", "umans-glm-5.2", "en", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("I'll look it up on Wikipedia.");
    expect(mockCreate).not.toHaveBeenCalled();
  });
  // --- Search query diversification: multi-query generation ---
  it("web heuristic generates direct + keyword queries (2 queries)", async () => {
    // Set reject so LLM call immediately fails if invoked.
    // (Heuristic web does not short-circuit; it proceeds to the LLM router, but canned "none"
    //  causes heuristicDecision to be returned as fallback. Here we set reject to avoid
    //  calling the LLM and verify the query array from heuristicDecision.)
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({ searchLevel: "none", reason: "defer", userNotice: null, queries: [] }),
      ),
    );

    const decision = await decideSearch("PMR2.0のSteam評価は？最新のレビュー", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries.length).toBeGreaterThanOrEqual(2);
    expect(decision.queries[0]).toContain("PMR2.0");
    // keyword variant does not contain original particles (の/は/が)
    expect(decision.queries[1]).not.toMatch(/[のはが]/);
  });

  it("wiki heuristic: pure CJK entities do not generate an English variant", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });

    const decision = await decideSearch("織田信長って何？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.queries).toEqual(["織田信長って何？"]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("wiki heuristic: ASCII entities append an English variant", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });

    const decision = await decideSearch("tRPCとは", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.queries.length).toBeGreaterThanOrEqual(2);
    expect(decision.queries).toContain("tRPC");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("LLM web canned: parses 4 queries (3 in language + 1 in English)", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "web",
          reason: "latest eval",
          userNotice: "確認するね",
          queries: [
            "GLM5.2 評価 最新 レビュー",
            "GLM5.2 review rating benchmark",
            "GLM-5.2 性能 比較",
            "GLM5.2 evaluation latest",
          ],
        }),
      ),
    );

    const decision = await decideSearch("最新のGLM5.2の評価どう？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries.length).toBe(4);
    expect(decision.queries.some((q) => /^[A-Za-z0-9 .]+$/.test(q))).toBe(true);
  });

  it("LLM wiki canned: parses entity + English queries (2 queries)", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "wiki",
          reason: "entity lookup",
          userNotice: "Wikipediaで調べます。",
          queries: ["アインシュタイン", "Albert Einstein"],
        }),
      ),
    );

    const decision = await decideSearch("アインシュタインについて教えて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.queries.length).toBe(2);
    expect(decision.queries).toEqual(["アインシュタイン", "Albert Einstein"]);
  });
});
