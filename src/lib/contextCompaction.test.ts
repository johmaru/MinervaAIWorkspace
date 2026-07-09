// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
import type OpenAI from "openai";

// LLM client mock: control the return value of create per test
function mockLlm(content: string | null) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

// LLM mock that throws an error
function failingLlm() {
  return {
    chat: {
      completions: {
        create: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      },
    },
  } as unknown as OpenAI;
}

import {
  estimateTokens,
  estimateMessagesTokens,
  compactHistory,
  type DbMessage,
} from "@/lib/contextCompaction";

function msg(role: DbMessage["role"], content: string, id?: string): DbMessage {
  return {
    id: id ?? `msg-${Math.random().toString(36).slice(2)}`,
    parentId: null,
    role,
    content,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("estimateTokens", () => {
  it("empty string is 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("ASCII text ≈ 4 chars = 1 token", () => {
    // "Hello world" = 11 chars → ceil(11/4) = 3
    expect(estimateTokens("Hello world")).toBe(3);
  });

  it("Japanese text ≈ 1 char = 1 token", () => {
    // "こんにちは" = 5 CJK chars → 5 tokens
    expect(estimateTokens("こんにちは")).toBe(5);
  });

  it("mixed text: CJK + ASCII", () => {
    // "Hello こんにちは" = 6 ASCII (H,e,l,l,o,space) + 5 CJK
    // = ceil(5*1 + 6/4) = ceil(5 + 1.5) = 7
    expect(estimateTokens("Hello こんにちは")).toBe(7);
  });
});

describe("estimateMessagesTokens", () => {
  it("content tokens per message + 4 overhead", () => {
    const messages = [
      { role: "user", content: "Hello world" }, // 3 + 4 = 7
      { role: "assistant", content: "こんにちは" }, // 5 + 4 = 9
    ];
    expect(estimateMessagesTokens(messages)).toBe(16);
  });

  it("empty array is 0", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

describe("compactHistory", () => {
  it("history of 6 or fewer is returned as-is", async () => {
    const history = [
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
    ];
    const result = await compactHistory({
      history,
      llm: mockLlm("summary"),
      model: "test-model",
    });
    expect(result).toBe(history);
  });

  it("history of 7 or more returns summary + last 4 messages", async () => {
    const history: DbMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push(msg("user", `質問${i}`));
      history.push(msg("assistant", `回答${i}`));
    }
    // 16 messages → toSummarize = first 12, recent = last 4
    const llm = mockLlm("これは要約です。");
    const result = await compactHistory({
      history,
      llm,
      model: "test-model",
    });

    // result = [summaryMsg, ...recent(4)]
    expect(result).toHaveLength(5);
    expect(result[0].role).toBe("system");
    expect(result[0].id).toBe("compacted-summary");
    expect(result[0].content).toContain("## 過去の会話要約");
    expect(result[0].content).toContain("これは要約です。");
    // last 4 messages are preserved
    expect(result[1]).toBe(history[12]);
    expect(result[4]).toBe(history[15]);

    // verify LLM was called
    expect(llm.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("on LLM error, returns original history as-is", async () => {
    const history: DbMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push(msg("user", `質問${i}`));
      history.push(msg("assistant", `回答${i}`));
    }
    const result = await compactHistory({
      history,
      llm: failingLlm(),
      model: "test-model",
    });
    expect(result).toBe(history);
  });

  it("summary prompt does not include system instructions (conversation history only)", async () => {
    const history: DbMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push(msg("user", `質問${i}`));
      history.push(msg("assistant", `回答${i}`));
    }
    const llm = mockLlm("要約");
    await compactHistory({ history, llm, model: "test-model" });

    const callArgs = (llm.chat.completions.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { messages: { content: string }[] };
    const userPrompt = callArgs.messages[1].content;
    // user prompt contains history
    expect(userPrompt).toContain("質問0");
    expect(userPrompt).toContain("回答5");
    // number of messages to summarize = 12 (16 - 4)
    expect(userPrompt.match(/ユーザー:/g)?.length).toBe(6);
    expect(userPrompt.match(/アシスタント:/g)?.length).toBe(6);
  });
});
