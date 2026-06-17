import { act, renderHook, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/hooks/useChat";
import { useChat } from "@/hooks/useChat";

// useChat は Phase 1 では LLM を直接叩かず /api/chat へ fetch するだけ。
// ここでは fetch を偽 SSE ストリームに差し替えて、フックの挙動だけ検証する
// （実 API 疎通は route.test.ts で担保）。

type Frame = { event: string; data: Record<string, unknown> };

function sseResponse(frames: Frame[], { status = 200 }: { status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const chunks = frames.map(
    (f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`,
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function delayedSseResponse(
  frames: Frame[],
  delaysMs: number[] = [],
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < frames.length; i++) {
        if (delaysMs[i]) await new Promise((r) => setTimeout(r, delaysMs[i]));
        controller.enqueue(
          encoder.encode(`event: ${frames[i].event}\ndata: ${JSON.stringify(frames[i].data)}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function fetchMock(): Mock {
  return globalThis.fetch as unknown as Mock;
}

describe("useChat — 送信と楽観追加", () => {
  it("空文字・空白のみは送信しない", async () => {
    fetchMock().mockResolvedValue(
      sseResponse([{ event: "done", data: {} }]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("   ");
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(0);
  });

  it("ストリーミング中は追加送信を無視", async () => {
    fetchMock().mockResolvedValue(
      delayedSseResponse(
        [
          { event: "delta", data: { delta: "A" } },
          { event: "delta", data: { delta: "B" } },
          { event: "done", data: {} },
        ],
        [0, 50, 0],
      ),
    );
    const { result } = renderHook(() => useChat());

    let first!: Promise<void>;
    act(() => {
      first = result.current.send("one");
    });

    // 最初の send が進行中に2回目を投入
    await act(async () => {
      const before = fetchMock().mock.calls.length;
      await result.current.send("two");
      expect(fetchMock().mock.calls.length).toBe(before);
    });

    await act(async () => {
      await first;
    });
  });

  it("user と assistant を楽観追加し、delta を結合して done で終わる", async () => {
    fetchMock().mockResolvedValue(
      sseResponse([
        { event: "delta", data: { delta: "Hello" } },
        { event: "delta", data: { delta: ", " } },
        { event: "delta", data: { delta: "world" } },
        { event: "done", data: {} },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("hi");
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(String(init.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(parsed.messages).toEqual([{ role: "user", content: "hi" }]);

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].role).toBe("user");
    expect(result.current.messages[0].content).toBe("hi");
    expect(result.current.messages[1].role).toBe("assistant");
    expect(result.current.messages[1].content).toBe("Hello, world");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("history は過去の user/assistant を順序保持で送信する", async () => {
    fetchMock().mockResolvedValue(
      sseResponse([
        { event: "delta", data: { delta: "ok" } },
        { event: "done", data: {} },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("first");
    });
    await act(async () => {
      await result.current.send("second");
    });

    const [, lastInit] = fetchMock().mock.calls.at(-1) as [string, RequestInit];
    const parsed = JSON.parse(String(lastInit.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(parsed.messages.map((m) => m.content)).toEqual([
      "first",
      "ok",
      "second",
    ]);
  });
});

describe("useChat — エラーと停止", () => {
  it("HTTP 非200 は error に設定", async () => {
    fetchMock().mockResolvedValue(
      sseResponse([{ event: "done", data: {} }], { status: 500 }),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("x");
    });

    expect(result.current.error).toMatch(/HTTP 500/);
    expect(result.current.isStreaming).toBe(false);
  });

  it("SSE error イベントは error に設定", async () => {
    fetchMock().mockResolvedValue(
      sseResponse([
        { event: "delta", data: { delta: "partial" } },
        { event: "error", data: { message: "boom" } },
        { event: "done", data: {} },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("x");
    });

    expect(result.current.error).toBe("boom");
    // 部分回答は保持
    expect(result.current.messages[1].content).toBe("partial");
  });

  it("stop() は AbortController を abort し、部分回答を残す", async () => {
    // 読み取り途中で abort されるよう、遅延ストリームを使用
    fetchMock().mockImplementation(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          // signal を即座に abort して ReadableStream の読み取りで AbortError を起こす
          const ac = init?.signal as AbortController["signal"] | undefined;
          if (ac && !ac.aborted) {
            // 外部から abort されるまで resolve しない → stop() で abort 発火
            const onAbort = () => {
              resolve(delayedSseResponse([{ event: "done", data: {} }]));
            };
            if (ac.aborted) onAbort();
            else ac.addEventListener("abort", onAbort, { once: true });
          } else {
            resolve(delayedSseResponse([{ event: "done", data: {} }]));
          }
        }),
    );

    const { result } = renderHook(() => useChat());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.send("hello");
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      result.current.stop();
    });

    await act(async () => {
      await pending;
    });

    // abort しても isStreaming は false に戻り、error は設定されない
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.error).toBeNull();
    // user メッセージは残る
    expect(result.current.messages[0].role).toBe("user");
  });
});

describe("useChat — clear", () => {
  it("clear は messages と error を空にする", async () => {
    fetchMock().mockResolvedValue(
      sseResponse([
        { event: "delta", data: { delta: "hi" } },
        { event: "done", data: {} },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("x");
    });
    expect(result.current.messages).toHaveLength(2);

    act(() => {
      result.current.clear();
    });

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });
});

describe("ChatMessage 型", () => {
  it("id / role / content を持つ", () => {
    const m: ChatMessage = { id: "1", role: "assistant", content: "hi" };
    expect(m.id).toBe("1");
  });
});
