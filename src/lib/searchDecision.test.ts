// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

// createLLM をモック: 実 API を叩かずに decideSearch のロジックを検証
const mockCreate = vi.fn();
vi.mock("@/lib/llm", () => ({
  createLLM: () => mockCreate(),
  buildDisableReasoningParams: () => Promise.resolve({ reasoning_effort: "none" }),
}));

import { decideSearch } from "@/lib/searchDecision";

/**
 * OpenAI クライアントのモックを構築。
 * create が返す content を指定。
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
  it("searchLevel:web + queries をパースする", async () => {
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

    const decision = await decideSearch("PMR2.0の評価は？", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.reason).toBe("latest reviews needed");
    expect(decision.userNotice).toBe("最新の評価やレビューをWebで確認します。");
    expect(decision.queries).toEqual([
      "Project Motor Racing 2.0 Steam review",
      "PMR 2.0 評価",
    ]);
  });

  it("searchLevel:none の場合は空 queries を返す", async () => {
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

    const decision = await decideSearch(
      "Pythonのリスト内包表記の使い方を教えて",
      "umans-glm-5.2",
      [],
    );

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
    expect(decision.userNotice).toBeNull();
  });

  it("LLM が検索不要と判定しても最新レビュー要求は検索へ倒す", async () => {
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

    const decision = await decideSearch(
      "Project Motor Racing 2.0のSteamでの評価はどうなってる？最新のレビュー状況を教えて",
      "umans-glm-5.2",
      [],
    );

    expect(decision.searchLevel).toBe("web");
    expect(decision.reason).toContain("heuristic");
    expect(decision.userNotice).toBe(
      "検索判定を定型ルールで補完し、Webで最新情報を確認します。",
    );
    expect(decision.queries[0]).toContain("Project Motor Racing 2.0");
    expect(decision.queries[0]).toContain("Steam");
  });

  it("LLM が不自然な userNotice を返しても丁寧な固定文に整形する", async () => {
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

    const decision = await decideSearch("GLM5.2の評価どうなってる？", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe("最新の評価やレビューをWebで確認します。");
  });

  it("Steam 系の検索判定成功時は Steam 用の固定文に整形する", async () => {
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

    const decision = await decideSearch("Project Motor Racing 2.0はSteamで配信されてる？", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe("Steamの最新情報をWebで確認します。");
  });

  it("markdown コードフェンス付き JSON をパースする", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        '```json\n{"searchLevel": "web", "reason": "need search", "userNotice": "確認するね", "queries": ["latest news"]}\n```',
      ),
    );

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries).toEqual(["latest news"]);
    expect(decision.userNotice).toBe("最新の情報をWebで確認します。");
  });

  it("フェンス無しのプレーン JSON もパースする", async () => {
    mockCreate.mockReturnValue(
      mockClient('{"searchLevel": "none", "reason": "ok", "userNotice": null, "queries": []}'),
    );

    const decision = await decideSearch("hi", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toBe("ok");
  });

  it("LLM が不正 JSON を返した場合は searchLevel:none でフォールバック", async () => {
    mockCreate.mockReturnValue(mockClient("this is not json"));

    const decision = await decideSearch("hi", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toBe("router failed");
    expect(decision.queries).toEqual([]);
  });

  it("LLM が不正 JSON を返しても明示的な検索要求なら検索へ倒す", async () => {
    mockCreate.mockReturnValue(mockClient("this is not json"));

    const decision = await decideSearch(
      "Project Motor Racing 2.0 Steam 最新レビューを調べて",
      "umans-glm-5.2",
      [],
    );

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe(
      "検索判定を定型ルールで補完し、Webで最新情報を確認します。",
    );
    expect(decision.queries[0]).toContain("Project Motor Racing 2.0");
  });

  it("LLM 呼び出しが reject した場合は searchLevel:none でフォールバック", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("network error")),
        },
      },
    });

    const decision = await decideSearch("hi", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toBe("router failed");
    expect(decision.queries).toEqual([]);
  });

  it("LLM 呼び出しが reject しても明示的な検索要求なら検索へ倒す", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("network error")),
        },
      },
    });

    const decision = await decideSearch(
      "この商品の現在の価格を確認して",
      "umans-glm-5.2",
      [],
    );

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe(
      "検索判定を定型ルールで補完し、Webで最新情報を確認します。",
    );
    expect(decision.queries[0]).toContain("現在の価格");
  });

  it("queries に空文字や非文字が混ざっても除外される", async () => {
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

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.queries).toEqual(["valid query", "another valid"]);
  });

  it("userNotice が空文字や whitespace-only の場合は null になる", async () => {
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

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("web");
    expect(decision.userNotice).toBe("最新の情報をWebで確認します。");
  });

  it("content が null の場合はフォールバック", async () => {
    mockCreate.mockReturnValue(mockClient(null));

    const decision = await decideSearch("hi", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
  });

  it("content が空文字の場合はフォールバック", async () => {
    mockCreate.mockReturnValue(mockClient(""));

    const decision = await decideSearch("hi", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toBe("router failed");
  });

  it("history を system prompt 以外の messages として渡す", async () => {
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

    await decideSearch("follow up", "umans-glm-5.2", [
      { role: "user", content: "前の質問" },
      { role: "assistant", content: "前の回答" },
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0] as { messages: { role: string; content: string }[] };
    // system, user, assistant, user の順
    expect(params.messages).toHaveLength(4);
    expect(params.messages[0].role).toBe("system");
    expect(params.messages[1]).toEqual({ role: "user", content: "前の質問" });
    expect(params.messages[2]).toEqual({ role: "assistant", content: "前の回答" });
    expect(params.messages[3]).toEqual({ role: "user", content: "follow up" });
  });

  it("response_format を使わず通常 completion で呼ぶ", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ searchLevel: "none", reason: "ok", userNotice: null, queries: [] }) } }],
    });
    mockCreate.mockReturnValue({ chat: { completions: { create } } });

    await decideSearch("hi", "umans-glm-5.2", []);

    const params = create.mock.calls[0][0] as { response_format?: unknown };
    expect(params.response_format).toBeUndefined();
  });

  it("記憶呼び出し質問は heuristic が検索を強制しない（LLM が不要と判定すれば検索しない）", async () => {
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

    const decision = await decideSearch("最近何の話しした？", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
  });

  it("記憶呼び出し質問は LLM 失敗時も検索しない", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("network error")),
        },
      },
    });

    const decision = await decideSearch("前に何を話したか覚えてる？", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toBe("router failed");
    expect(decision.queries).toEqual([]);
  });

  it("記憶呼び出し質問の英語パターンも検索を抑制する", async () => {
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

    const decision = await decideSearch("what did we talk about last time?", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
  });

  it("記憶呼び出し質問の英語バリエーションを網羅的に検索抑制する", async () => {
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
      const decision = await decideSearch(q, "umans-glm-5.2", []);
      expect(decision.searchLevel, `query: ${q}`).toBe("none");
    }
  });

  it("コード質問はヒューリスティックで検索不要となり LLM を呼ばない", async () => {
    // LLM が呼ばれたら即座に失敗するよう reject を設定
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM should not be called")),
        },
      },
    });

    const decision = await decideSearch("Pythonでフィボナッチ数列を計算するコードを書いて", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.reason).toContain("heuristic");
    expect(decision.queries).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("翻訳依頼はヒューリスティックで検索不要となり LLM を呼ばない", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM should not be called")),
        },
      },
    });

    const decision = await decideSearch("この文章を英語に翻訳して", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("意見・アドバイス要求はヒューリスティックで検索不要となり LLM を呼ばない", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM should not be called")),
        },
      },
    });

    const decision = await decideSearch("このデザインについてどう思う？アドバイスをちょうだい", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(decision.queries).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("英語のコード質問もヒューリスティックで検索不要となる", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM should not be called")),
        },
      },
    });

    const decision = await decideSearch("write a program to sort an array", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("none");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("検索不要パターンでも明示的に「検索して」とあれば LLM 判定へ進む", async () => {
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

    const decision = await decideSearch("最新の Python コードを検索して", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("web");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("UNKNOWN_TERM ヒューリスティック（Xって何）は searchLevel:wiki となる", async () => {
    // LLM が呼ばれたら即座に失敗するよう reject を設定
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM should not be called")),
        },
      },
    });

    const decision = await decideSearch("マグナ・カルタって何？", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(decision.queries).toEqual(["マグナ・カルタって何？"]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // --- Step 7: 拡張 UNKNOWN_TERM_PATTERN のテスト ---
  // 全てヒューリスティックで捕捉され LLM が呼ばれないことを検証する。
  it("Xって性格悪かったの？ は wiki となる（って性格 マッチ）", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("欠地王ジョンって性格悪かったの？", "umans-glm-5.2", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(decision.queries).toEqual(["欠地王ジョンって性格悪かったの？"]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("Xってどんな人だった？ は wiki となる（ってどんな マッチ）", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("織田信長ってどんな人だった？", "umans-glm-5.2", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("Xって本当にいたの？ は wiki となる（って本当 マッチ）", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("ソクラテスって本当にいたの？", "umans-glm-5.2", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("Xって実在する？ は wiki となる（って実在 マッチ）", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("シャーロック・ホームズって実在する？", "umans-glm-5.2", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("Xって誰？ は wiki となる（って誰 マッチ）", async () => {
    mockCreate.mockReturnValue({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("LLM should not be called")) } },
    });
    const decision = await decideSearch("ジョン王って誰？", "umans-glm-5.2", []);
    expect(decision.searchLevel).toBe("wiki");
    expect(decision.userNotice).toBe("Wikipediaで調べます。");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("LLM が searchLevel:wiki を返した場合パースする", async () => {
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

    const decision = await decideSearch("マグナ・カルタについて教えて", "umans-glm-5.2", []);

    expect(decision.searchLevel).toBe("wiki");
    expect(decision.queries).toEqual(["マグナ・カルタ"]);
    // ヒューリスティックが null（パターン非マッチ）の場合 LLM が wiki を返す。
    // normalizeDecisionNotice は buildUserNotice で再計算するが、UNKNOWN_TERM_PATTERN
    // 非マッチのため DEFAULT_USER_NOTICE になる（プラン想定: wiki 専用分岐なし）。
  });
});
