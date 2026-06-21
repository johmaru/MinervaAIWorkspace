// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

// createLLM をモック: 実 API を叩かずに decideSearch のロジックを検証
const mockCreate = vi.fn();
vi.mock("@/lib/llm", () => ({
  createLLM: () => mockCreate(),
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
  it("needsSearch:true + queries をパースする", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          needsSearch: true,
          reason: "latest reviews needed",
          userNotice: "Steamの評価は変わるので、最新のレビュー状況を確認するね。",
          queries: ["Project Motor Racing 2.0 Steam review", "PMR 2.0 評価"],
        }),
      ),
    );

    const decision = await decideSearch("PMR2.0の評価は？", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(true);
    expect(decision.reason).toBe("latest reviews needed");
    expect(decision.userNotice).toBe("最新の評価やレビューをWebで確認します。");
    expect(decision.queries).toEqual([
      "Project Motor Racing 2.0 Steam review",
      "PMR 2.0 評価",
    ]);
  });

  it("needsSearch:false の場合は空 queries を返す", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          needsSearch: false,
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

    expect(decision.needsSearch).toBe(false);
    expect(decision.queries).toEqual([]);
    expect(decision.userNotice).toBeNull();
  });

  it("LLM が検索不要と判定しても最新レビュー要求は検索へ倒す", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          needsSearch: false,
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

    expect(decision.needsSearch).toBe(true);
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
          needsSearch: true,
          reason: "current evaluation",
          userNotice: "GLM5.2の評価は新しく出ている情報に変わるから、最新の状況を調べるね。",
          queries: ["GLM5.2 評価 最新"],
        }),
      ),
    );

    const decision = await decideSearch("GLM5.2の評価どうなってる？", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(true);
    expect(decision.userNotice).toBe("最新の評価やレビューをWebで確認します。");
  });

  it("Steam 系の検索判定成功時は Steam 用の固定文に整形する", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          needsSearch: true,
          reason: "steam status",
          userNotice: "Steamを確認するね",
          queries: ["Project Motor Racing 2.0 Steam"],
        }),
      ),
    );

    const decision = await decideSearch("Project Motor Racing 2.0はSteamで配信されてる？", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(true);
    expect(decision.userNotice).toBe("Steamの最新情報をWebで確認します。");
  });

  it("markdown コードフェンス付き JSON をパースする", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        '```json\n{"needsSearch": true, "reason": "need search", "userNotice": "確認するね", "queries": ["latest news"]}\n```',
      ),
    );

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(true);
    expect(decision.queries).toEqual(["latest news"]);
    expect(decision.userNotice).toBe("最新の情報をWebで確認します。");
  });

  it("フェンス無しのプレーン JSON もパースする", async () => {
    mockCreate.mockReturnValue(
      mockClient('{"needsSearch": false, "reason": "ok", "userNotice": null, "queries": []}'),
    );

    const decision = await decideSearch("hi", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(false);
    expect(decision.reason).toBe("ok");
  });

  it("LLM が不正 JSON を返した場合は needsSearch:false でフォールバック", async () => {
    mockCreate.mockReturnValue(mockClient("this is not json"));

    const decision = await decideSearch("hi", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(false);
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

    expect(decision.needsSearch).toBe(true);
    expect(decision.userNotice).toBe(
      "検索判定を定型ルールで補完し、Webで最新情報を確認します。",
    );
    expect(decision.queries[0]).toContain("Project Motor Racing 2.0");
  });

  it("LLM 呼び出しが reject した場合は needsSearch:false でフォールバック", async () => {
    mockCreate.mockReturnValue({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("network error")),
        },
      },
    });

    const decision = await decideSearch("hi", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(false);
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

    expect(decision.needsSearch).toBe(true);
    expect(decision.userNotice).toBe(
      "検索判定を定型ルールで補完し、Webで最新情報を確認します。",
    );
    expect(decision.queries[0]).toContain("現在の価格");
  });

  it("queries に空文字や非文字が混ざっても除外される", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          needsSearch: true,
          reason: "need search",
          userNotice: "確認するね",
          queries: ["valid query", "", "  ", 123, null, "another valid"],
        }),
      ),
    );

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(true);
    expect(decision.queries).toEqual(["valid query", "another valid"]);
  });

  it("userNotice が空文字や whitespace-only の場合は null になる", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          needsSearch: true,
          reason: "need search",
          userNotice: "   ",
          queries: ["q"],
        }),
      ),
    );

    const decision = await decideSearch("最新ニュース", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(true);
    expect(decision.userNotice).toBe("最新の情報をWebで確認します。");
  });

  it("content が null の場合はフォールバック", async () => {
    mockCreate.mockReturnValue(mockClient(null));

    const decision = await decideSearch("hi", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(false);
    expect(decision.queries).toEqual([]);
  });

  it("content が空文字の場合はフォールバック", async () => {
    mockCreate.mockReturnValue(mockClient(""));

    const decision = await decideSearch("hi", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(false);
    expect(decision.reason).toBe("router failed");
  });

  it("history を system prompt 以外の messages として渡す", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              needsSearch: false,
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
      choices: [{ message: { content: JSON.stringify({ needsSearch: false, reason: "ok", userNotice: null, queries: [] }) } }],
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
          needsSearch: false,
          reason: "asking about past conversation",
          userNotice: null,
          queries: [],
        }),
      ),
    );

    const decision = await decideSearch("最近何の話しした？", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(false);
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

    expect(decision.needsSearch).toBe(false);
    expect(decision.reason).toBe("router failed");
    expect(decision.queries).toEqual([]);
  });

  it("記憶呼び出し質問の英語パターンも検索を抑制する", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          needsSearch: false,
          reason: "recall question",
          userNotice: null,
          queries: [],
        }),
      ),
    );

    const decision = await decideSearch("what did we talk about last time?", "umans-glm-5.2", []);

    expect(decision.needsSearch).toBe(false);
  });

  it("記憶呼び出し質問の英語バリエーションを網羅的に検索抑制する", async () => {
    mockCreate.mockReturnValue(
      mockClient(
        JSON.stringify({
          needsSearch: false,
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
            needsSearch: false,
            reason: "recall question",
            userNotice: null,
            queries: [],
          }),
        ),
      );
      const decision = await decideSearch(q, "umans-glm-5.2", []);
      expect(decision.needsSearch, `query: ${q}`).toBe(false);
    }
  });
});
