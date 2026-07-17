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
 * Builds a mock OpenAI client whose `create` returns sequential responses.
 * Pass an array of contents; each call to `create` returns the next content.
 * For 2-phase decideSearch: 1st call = judge, 2nd call = queryGen.
 */
function mockClientSequential(contents: (string | null)[]) {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(() => {
          const content = callIndex < contents.length ? contents[callIndex] : contents[contents.length - 1];
          callIndex++;
          return Promise.resolve({
            choices: [{ message: { content } }],
          });
        }),
      },
    },
  };
}

/**
 * Convenience: single-response mock (for tests where only the judge phase runs,
 * e.g. searchLevel:none causes queryGen to be skipped).
 */
function mockClient(content: string | null) {
  return mockClientSequential([content]);
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe("decideSearch", () => {
  it("parses searchLevel:web + generates queries in 2 phases", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        // Phase A: judge
        JSON.stringify({
          searchLevel: "web",
          reason: "latest reviews needed",
          userNotice: "Steamの評価は変わるので、最新のレビュー状況を確認するね。",
        }),
        // Phase B: query generation
        JSON.stringify({
          queries: [
            { query: "Project Motor Racing 2.0 Steam review", time_range: null },
            { query: "PMR 2.0 評価", time_range: null },
          ],
        }),
      ]),
    );

    const decision = await decideSearch("PMR2.0の評価は？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.reason).toBe("latest reviews needed");
    expect(decision.userNotice).toBe("最新の評価やレビューをWebで確認します。");
    expect(decision.queries).toEqual([
      { query: "Project Motor Racing 2.0 Steam review", time_range: null },
      { query: "PMR 2.0 評価", time_range: null },
    ]);
  });

  it("returns empty queries when searchLevel is none (queryGen skipped)", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "none",
          reason: "stable knowledge",
          userNotice: null,
        }),
      ),
    );

    const decision = await decideSearch("Pythonのリスト内包表記の使い方を教えて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
    expect(decision.userNotice).toBeNull();
  });

  it("routes to search even when LLM judges none, if latest review is requested (heuristic fallback)", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "none",
          reason: "stable knowledge",
          userNotice: null,
        }),
      ),
    );

    const decision = await decideSearch("Project Motor Racing 2.0のSteamでの評価はどうなってる？最新のレビュー状況を教えて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.reason).toContain("heuristic");
    expect(decision.userNotice).toBe(
      "検索判定を定型ルールで補完し、Webで最新情報を確認します。",
    );
    // Step 9: queries[0] is now keyword-focused (not raw user message)
    expect(decision.queries[0].query).toContain("Project Motor Racing 2.0");
  });

  it("normalizes unnatural userNotice from LLM into a polite fixed sentence", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        JSON.stringify({
          searchLevel: "web",
          reason: "current evaluation",
          userNotice: "GLM5.2の評価は新しく出ている情報に変わるから、最新の状況を調べるね。",
        }),
        JSON.stringify({
          queries: [{ query: "GLM5.2 評価 最新", time_range: null }],
        }),
      ]),
    );

    const decision = await decideSearch("GLM5.2の評価どうなってる？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe("最新の評価やレビューをWebで確認します。");
  });

  it("normalizes to Steam-specific fixed sentence on Steam-related search decision success", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        JSON.stringify({
          searchLevel: "web",
          reason: "steam status",
          userNotice: "Steamを確認するね",
        }),
        JSON.stringify({
          queries: [{ query: "Project Motor Racing 2.0 Steam", time_range: null }],
        }),
      ]),
    );

    const decision = await decideSearch("Project Motor Racing 2.0はSteamで配信されてる？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe("Steamの最新情報をWebで確認します。");
  });

  it("parses JSON wrapped in markdown code fences (judge phase)", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        '```json\n{"searchLevel": "web", "reason": "need search", "userNotice": "確認するね"}\n```',
        JSON.stringify({
          queries: [{ query: "latest news", time_range: null }],
        }),
      ]),
    );

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries).toEqual([{ query: "latest news", time_range: null }]);
    expect(decision.userNotice).toBe("最新の情報をWebで確認します。");
  });

  it("also parses plain JSON without fences", async () => {
    mockCreate.mockReturnValue(
      mockClient('{"searchLevel": "none", "reason": "ok", "userNotice": null}'),
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

  it("routes to search on explicit search request even when LLM judge returns invalid JSON", async () => {
    mockCreate.mockReturnValue(mockClient("this is not json"));

    const decision = await decideSearch("Project Motor Racing 2.0 Steam 最新レビューを調べて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe(
      "検索判定を定型ルールで補完し、Webで最新情報を確認します。",
    );
    // Step 9: queries[0] is now keyword-focused
    expect(decision.queries[0].query).toContain("Project Motor Racing 2.0");
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
    // Heuristic fallback: keyword extraction (no raw conversational sentence as primary)
    expect(decision.queries[0].query).toContain("価格");
    expect(decision.queries[0].query).not.toMatch(/確認して/);
    // Recency bias adds a second "最新" variant when volatile
    expect(decision.queries.some((q) => /最新/.test(q.query))).toBe(true);
  });

  it("filters out empty strings and non-strings from queries (queryGen phase)", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        JSON.stringify({
          searchLevel: "web",
          reason: "need search",
          userNotice: "確認するね",
        }),
        JSON.stringify({
          queries: [
            { query: "valid query", time_range: null },
            { query: "", time_range: null },
            { query: "  ", time_range: null },
            { query: 123, time_range: null },
            { query: null, time_range: null },
            { query: "another valid", time_range: null },
          ],
        }),
      ]),
    );

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries).toEqual([
      { query: "valid query", time_range: null },
      { query: "another valid", time_range: null },
    ]);
  });

  it("sets userNotice to null when empty or whitespace-only", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        JSON.stringify({
          searchLevel: "web",
          reason: "need search",
          userNotice: "   ",
        }),
        JSON.stringify({
          queries: [{ query: "q", time_range: null }],
        }),
      ]),
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

  it("passes history as messages other than the system prompt (judge phase)", async () => {
    const create = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ searchLevel: "none", reason: "stable", userNotice: null }) } }],
      });
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
    const create = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ searchLevel: "none", reason: "ok", userNotice: null }) } }],
      });
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
      mockClientSequential([
        JSON.stringify({
          searchLevel: "web",
          reason: "explicit search requested",
          userNotice: null,
        }),
        JSON.stringify({
          queries: [{ query: "最新の Python コード事例", time_range: null }],
        }),
      ]),
    );

    const decision = await decideSearch("最新の Python コードを検索して", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    // judge + queryGen = 2 LLM calls
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
    expect(decision.queries).toEqual([{ query: "マグナ・カルタって何？", time_range: null }]);
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
    expect(decision.queries).toEqual([{ query: "欠地王ジョンって性格悪かったの？", time_range: null }]);
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

  it("parses when LLM returns searchLevel:wiki (2-phase: judge=wiki, queryGen=queries)", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        JSON.stringify({
          searchLevel: "wiki",
          reason: "named entity lookup",
          userNotice: "Wikipediaで調べます。",
        }),
        JSON.stringify({
          queries: [{ query: "マグナ・カルタ", time_range: null }],
        }),
      ]),
    );

    const decision = await decideSearch("マグナ・カルタについて教えて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.queries).toEqual([{ query: "マグナ・カルタ", time_range: null }]);
  });

  // --- English locale: heuristic pattern extension verification ---
  it("en: \"who was Socrates\" results in wiki judgment and does not call LLM", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("who was Socrates", "umans-glm-5.2", "en", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("I'll look it up on Wikipedia.");
    expect(decision.queries).toEqual([{ query: "who was Socrates", time_range: null }]);
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
  it("web heuristic generates keyword + direct queries (2 queries, SearchQuery[])", async () => {
    // Heuristic web does not short-circuit; it proceeds to the LLM router.
    // Canned "none" causes heuristicDecision to be returned as fallback.
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({ searchLevel: "none", reason: "defer", userNotice: null }),
      ),
    );

    const decision = await decideSearch("PMR2.0のSteam評価は？最新のレビュー", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries.length).toBeGreaterThanOrEqual(1);
    // Keyword extraction keeps product tokens and drops particles/filler
    expect(decision.queries[0].query).toContain("PMR2.0");
    expect(decision.queries[0].query).not.toMatch(/[のはが]/);
    expect(decision.queries.every((q) => !/教えて|どうなってる/.test(q.query))).toBe(true);
  });

  it("wiki heuristic: pure CJK entities do not generate an English variant", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });

    const decision = await decideSearch("織田信長って何？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.queries).toEqual([{ query: "織田信長って何？", time_range: null }]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("wiki heuristic: ASCII entities append an English variant", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });

    const decision = await decideSearch("tRPCとは", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.queries.length).toBeGreaterThanOrEqual(2);
    expect(decision.queries.map((sq) => sq.query)).toContain("tRPC");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("passes a signal (15s timeout) to the LLM create call", async () => {
    const create = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ searchLevel: "none", reason: "x", userNotice: null }) } }],
      });
    });
    mockCreate.mockReturnValue({
      chat: { completions: { create } },
    });

    await decideSearch("hello", "umans-glm-5.2", "ja", []);

    // Second argument is RequestOptions; must contain an AbortSignal for the 15s timeout.
    const requestOptions = create.mock.calls[0]?.[1];
    expect(requestOptions).toBeDefined();
    expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("LLM web canned: parses 4 queries (3 in language + 1 in English) with time_range", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        JSON.stringify({
          searchLevel: "web",
          reason: "latest eval",
          userNotice: "確認するね",
        }),
        JSON.stringify({
          queries: [
            { query: "GLM5.2 評価 最新 レビュー", time_range: null },
            { query: "GLM5.2 review rating benchmark", time_range: null },
            { query: "GLM-5.2 性能 比較", time_range: null },
            { query: "GLM5.2 evaluation latest", time_range: null },
          ],
        }),
      ]),
    );

    const decision = await decideSearch("最新のGLM5.2の評価どう？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries.length).toBe(4);
    expect(decision.queries.some((sq) => /^[A-Za-z0-9 .]+$/.test(sq.query))).toBe(true);
  });

  it("LLM wiki canned: parses entity + English queries (2 queries)", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        JSON.stringify({
          searchLevel: "wiki",
          reason: "entity lookup",
          userNotice: "Wikipediaで調べます。",
        }),
        JSON.stringify({
          queries: [
            { query: "アインシュタイン", time_range: null },
            { query: "Albert Einstein", time_range: null },
          ],
        }),
      ]),
    );

    const decision = await decideSearch("アインシュタインについて教えて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.queries.length).toBe(2);
    expect(decision.queries).toEqual([
      { query: "アインシュタイン", time_range: null },
      { query: "Albert Einstein", time_range: null },
    ]);
  });

  // --- 2-phase specific tests ---

  it("queryGen phase generates queries with per-query time_range", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        JSON.stringify({
          searchLevel: "web",
          reason: "today's news",
          userNotice: null,
        }),
        JSON.stringify({
          queries: [
            { query: "AI ニュース 2026年7月11日", time_range: "day" },
            { query: "AI 最新ニュース", time_range: "week" },
            { query: "AI news July 2026", time_range: "week" },
          ],
        }),
      ]),
    );

    const decision = await decideSearch("今日のAIニュースってなんか有る？", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries).toEqual([
      { query: "AI ニュース 2026年7月11日", time_range: "day" },
      { query: "AI 最新ニュース", time_range: "week" },
      { query: "AI news July 2026", time_range: "week" },
    ]);
  });

  it("queryGen fallback: uses userMessage as query when queryGen returns invalid JSON", async () => {
    mockCreate.mockReturnValue(
      mockClientSequential([
        JSON.stringify({
          searchLevel: "web",
          reason: "need search",
          userNotice: null,
        }),
        "not valid json",
      ]),
    );

    const decision = await decideSearch("最新のAIニュース教えて", "umans-glm-5.2", "ja", []);

    expect(decision.searchLevel).toBe("web");
    // Fallback: heuristic decision (since heuristicDecision is available for this web-triggering input)
    expect(decision.queries.length).toBeGreaterThanOrEqual(1);
  });

  it("accepts envContext parameter (6th arg) without breaking", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          searchLevel: "none",
          reason: "stable",
          userNotice: null,
        }),
      ),
    );

    const decision = await decideSearch("hi", "umans-glm-5.2", "ja", [], undefined, "Current date: 2026-07-11");

    expect(decision.searchLevel).toBe("none");
  });

  it("injects envContext into system prompt for judge phase", async () => {
    const create = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ searchLevel: "none", reason: "stable", userNotice: null }) } }],
      });
    });
    mockCreate.mockReturnValue({ chat: { completions: { create } } });

    await decideSearch("hi", "umans-glm-5.2", "ja", [], undefined, "Current date: 2026-07-11");

    const params = create.mock.calls[0][0] as { messages: { role: string; content: string }[] };
    expect(params.messages[0].content).toContain("Current date: 2026-07-11");
  });
});
