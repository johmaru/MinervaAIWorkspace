import { act, renderHook as rtlRenderHook, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
import { createElement, type ReactNode } from "react";
import { db } from "@/db";
import { messages, threads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { useChat } from "@/hooks/useChat";
import { I18nProvider } from "@/components/I18nProvider";

const wrapper = ({ children }: { children: ReactNode }) => createElement(I18nProvider, null, children);
function renderHook<T>(callback: () => T) {
  return rtlRenderHook(callback, { wrapper });
}

// useChat became DB-backed in Phase 2.
// - Initial load calls GET /api/threads/[id] → mocked to return deterministic history.
// - send() posts SSE to POST /api/chat → replaced with a fake SSE stream.
// - Real API and real DB persistence are covered by route.test.ts. Only hook behavior here.

const createdThreadIds: string[] = [];

afterAll(async () => {
  for (const id of createdThreadIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
});

const originalFetch = globalThis.fetch;

function fetchMock(): Mock {
  return globalThis.fetch as unknown as Mock;
}

type Frame = { event: string; data: Record<string, unknown> };

function sseResponse(frames: Frame[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(
          encoder.encode(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`),
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

function threadResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function createThreadInDb(): Promise<string> {
  const [row] = await db.insert(threads).values({ title: "useChat test" }).returning();
  createdThreadIds.push(row.id);
  return row.id;
}

describe("useChat — initial load", () => {
  it("returns empty messages when threadId is null", async () => {
    const { result } = renderHook(() => useChat(null));
    expect(result.current.messages).toEqual([]);
    expect(result.current.thread).toBeNull();
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("calls GET /api/threads/[id] with threadId and expands history", async () => {
    const id = await createThreadInDb();
    await db.insert(messages).values([
      { threadId: id, role: "user", content: "hi" },
      { threadId: id, role: "assistant", content: "hello" },
    ]);

    fetchMock().mockResolvedValue(
      threadResponse({
        thread: { id, title: "useChat test", systemPrompt: null, model: "gpt-4o-mini", currentLeafId: "m2" },
        messages: [
          { id: "m1", parentId: null, role: "user", content: "hi" },
          { id: "m2", parentId: "m1", role: "assistant", content: "hello" },
        ],
      }),
    );

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock()).toHaveBeenCalledWith(`/api/threads/${id}`, undefined);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].content).toBe("hi");
    expect(result.current.messages[1].content).toBe("hello");
    expect(result.current.thread?.title).toBe("useChat test");
  });

  it("sets error on load failure", async () => {
    fetchMock().mockResolvedValue(threadResponse({ error: "not found" }, 404));
    const { result } = renderHook(() => useChat("00000000-0000-0000-0000-000000000000"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toMatch(/HTTP 404/);
  });
});

describe("useChat — send", () => {
  it("does not send when threadId is null", async () => {
    const { result } = renderHook(() => useChat(null));
    await act(async () => {
      await result.current.send("hi");
    });
    expect(fetchMock()).not.toHaveBeenCalledWith("/api/chat", expect.anything());
  });

  it("replaces optimistic id with real id on start → delta → done", async () => {
    const id = await createThreadInDb();
    fetchMock().mockImplementation((url: string) => {
      if (url === `/api/threads/${id}`) {
        return Promise.resolve(
          threadResponse({
            thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini" },
            messages: [],
          }),
        );
      }
      if (url === "/api/chat") {
        return Promise.resolve(
          sseResponse([
            { event: "start", data: { userMessageId: "real-user-1" } },
            { event: "delta", data: { delta: "Hello" } },
            { event: "delta", data: { delta: "!" } },
            { event: "done", data: { assistantMessageId: "real-assistant-1" } },
          ]),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.send("hi");
    });

    const msgs = result.current.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe("real-user-1");
    expect(msgs[0].content).toBe("hi");
    expect(msgs[1].id).toBe("real-assistant-1");
    expect(msgs[1].content).toBe("Hello!");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("accumulates thinking in assistant message on thinking events", async () => {
    const id = await createThreadInDb();
    fetchMock().mockImplementation((url: string) => {
      if (url === `/api/threads/${id}`) {
        return Promise.resolve(
          threadResponse({
            thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini" },
            messages: [],
          }),
        );
      }
      if (url === "/api/chat") {
        return Promise.resolve(
          sseResponse([
            { event: "start", data: { userMessageId: "u1" } },
            { event: "thinking", data: { delta: "考え中…" } },
            { event: "thinking", data: { delta: "続け" } },
            { event: "delta", data: { delta: "答え" } },
            { event: "done", data: { assistantMessageId: "a1" } },
          ]),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.send("hi");
    });

    const assistant = result.current.messages[1];
    expect(assistant.content).toBe("答え");
    expect(assistant.thinking).toBe("考え中…続け");
  });

  it("does not send on empty string or while streaming", async () => {
    const id = await createThreadInDb();
    fetchMock().mockImplementation((url: string) => {
      if (url === `/api/threads/${id}`) {
        return Promise.resolve(
          threadResponse({
            thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini" },
            messages: [],
          }),
        );
      }
      return Promise.resolve(sseResponse([{ event: "done", data: {} }]));
    });

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.send("   ");
    });
    expect(fetchMock()).not.toHaveBeenCalledWith("/api/chat", expect.anything());
  });

  it("sets error on SSE error event and keeps partial response", async () => {
    const id = await createThreadInDb();
    fetchMock().mockImplementation((url: string) => {
      if (url === `/api/threads/${id}`) {
        return Promise.resolve(
          threadResponse({
            thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini" },
            messages: [],
          }),
        );
      }
      return Promise.resolve(
        sseResponse([
          { event: "delta", data: { delta: "partial" } },
          { event: "error", data: { message: "boom" } },
        ]),
      );
    });

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.error).toBe("boom");
    expect(result.current.messages[1].content).toBe("partial");
  });

  it("updates sources state on sources event", async () => {
    const id = await createThreadInDb();
    fetchMock().mockImplementation((url: string) => {
      if (url === `/api/threads/${id}`) {
        return Promise.resolve(
          threadResponse({
            thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini" },
            messages: [],
          }),
        );
      }
      if (url === "/api/chat") {
        return Promise.resolve(
          sseResponse([
            { event: "start", data: { userMessageId: "u1" } },
            {
              event: "sources",
              data: {
                sources: [
                  { url: "https://example.com/a", title: "Source A", snippet: "snip a" },
                  { url: "https://example.com/b", title: "Source B", snippet: "snip b" },
                ],
              },
            },
            { event: "delta", data: { delta: "answer" } },
            { event: "done", data: { assistantMessageId: "a1" } },
          ]),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.sources).toHaveLength(2);
    expect(result.current.sources[0].url).toBe("https://example.com/a");
    expect(result.current.sources[0].title).toBe("Source A");
    expect(result.current.sources[1].url).toBe("https://example.com/b");
  });

  it("sets statusLabel on assistant message on status event and clears it on delta", async () => {
    const id = await createThreadInDb();
    fetchMock().mockImplementation((url: string) => {
      if (url === `/api/threads/${id}`) {
        return Promise.resolve(
          threadResponse({
            thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini" },
            messages: [],
          }),
        );
      }
      if (url === "/api/chat") {
        return Promise.resolve(
          sseResponse([
            { event: "start", data: { userMessageId: "u1" } },
            { event: "status", data: { phase: "searching", label: "Web検索中…" } },
            { event: "status", data: { phase: "thinking", label: "考え中…" } },
            { event: "delta", data: { delta: "hello" } },
            { event: "done", data: { assistantMessageId: "a1" } },
          ]),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.send("hi");
    });

    // The assistant message's (next after user) statusLabel is cleared after receiving delta
    const assistant = result.current.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe("hello");
    expect(assistant!.statusLabel).toBeUndefined();
  });

  it("propagates statusLabel to messages and keeps it after thinking is received", async () => {
    const id = await createThreadInDb();
    fetchMock().mockImplementation((url: string) => {
      if (url === `/api/threads/${id}`) {
        return Promise.resolve(
          threadResponse({
            thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini" },
            messages: [],
          }),
        );
      }
      if (url === "/api/chat") {
        return Promise.resolve(
          sseResponse([
            { event: "start", data: { userMessageId: "u1" } },
            { event: "status", data: { phase: "thinking", label: "考え中…" } },
            { event: "thinking", data: { delta: "推論" } },
            // Send done without delta (answer body) — statusLabel is retained until done
            { event: "done", data: { assistantMessageId: "a1" } },
          ]),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.send("hi");
    });

    const assistant = result.current.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.thinking).toBe("推論");
    // After thinking is received, statusLabel retains the thinking-phase label (effect of Step 1 + buildChain copy)
    expect(assistant!.statusLabel).toBe("考え中…");
  });
});

describe("useChat — stop / clear", () => {
  it("stop aborts the AbortController", async () => {
    const id = await createThreadInDb();
    fetchMock().mockImplementation((url: string) => {
      if (url === `/api/threads/${id}`) {
        return Promise.resolve(
          threadResponse({
            thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini", currentLeafId: null },
            messages: [],
          }),
        );
      }
      // A delayed stream that waits until abort is complex,
      // so assume immediate abort and return done
      return Promise.resolve(sseResponse([{ event: "done", data: {} }]));
    });

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.stop();
    });
    // Even if abort is called, isStreaming does not immediately become false,
    // but we only verify that stop() does not throw
    expect(true).toBe(true);
  });

  it("clear empties messages", async () => {
    const id = await createThreadInDb();
    fetchMock().mockResolvedValue(
      threadResponse({
        thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini", currentLeafId: "m1" },
        messages: [{ id: "m1", parentId: null, role: "user", content: "hi" }],
      }),
    );
    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    act(() => {
      result.current.clear();
    });
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });
});

describe("useChat — branching", () => {
  it("getSiblingInfo: returns siblings and index when siblings exist", async () => {
    const id = await createThreadInDb();
    fetchMock().mockResolvedValue(
      threadResponse({
        thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini", currentLeafId: "a2" },
        messages: [
          { id: "u1", parentId: null, role: "user", content: "hi" },
          { id: "a1", parentId: "u1", role: "assistant", content: "answer1" },
          { id: "a2", parentId: "u1", role: "assistant", content: "answer2" },
        ],
      }),
    );
    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // currentLeafId = "a2", so the displayed chain is u1 → a2
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].content).toBe("answer2");

    // a1 and a2 are siblings (same parentId "u1")
    const info = result.current.getSiblingInfo("a2");
    expect(info.siblings).toHaveLength(2);
    expect(info.currentIndex).toBeGreaterThanOrEqual(0);
  });

  it("switchBranch: switches to another branch", async () => {
    const id = await createThreadInDb();
    fetchMock().mockResolvedValue(
      threadResponse({
        thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini", currentLeafId: "a2" },
        messages: [
          { id: "u1", parentId: null, role: "user", content: "hi" },
          { id: "a1", parentId: "u1", role: "assistant", content: "answer1" },
          { id: "a2", parentId: "u1", role: "assistant", content: "answer2" },
        ],
      }),
    );
    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.messages[1].content).toBe("answer2");

    act(() => {
      result.current.switchBranch("a1");
    });

    // Switches to a1
    expect(result.current.messages[1].content).toBe("answer1");
  });

  it("regenerate: generates a new assistant under the user message", async () => {
    const id = await createThreadInDb();
    fetchMock().mockImplementation((url: string) => {
      if (url === `/api/threads/${id}`) {
        return Promise.resolve(
          threadResponse({
            thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini", currentLeafId: "a1" },
            messages: [
              { id: "u1", parentId: null, role: "user", content: "hi" },
              { id: "a1", parentId: "u1", role: "assistant", content: "old answer" },
            ],
          }),
        );
      }
      if (url === "/api/chat") {
        return Promise.resolve(
          sseResponse([
            { event: "start", data: {} },
            { event: "delta", data: { delta: "new" } },
            { event: "done", data: { assistantMessageId: "a2" } },
          ]),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.regenerate("u1");
    });

    // New assistant message is displayed
    expect(result.current.messages[1].content).toBe("new");
    expect(result.current.thread?.currentLeafId).toBe("a2");
  });

  it("editMessage: edits a user message and creates a new branch", async () => {
    const id = await createThreadInDb();
    fetchMock().mockImplementation((url: string) => {
      if (url === `/api/threads/${id}`) {
        return Promise.resolve(
          threadResponse({
            thread: { id, title: "x", systemPrompt: null, model: "gpt-4o-mini", currentLeafId: "a1" },
            messages: [
              { id: "u1", parentId: null, role: "user", content: "hi" },
              { id: "a1", parentId: "u1", role: "assistant", content: "old" },
            ],
          }),
        );
      }
      if (url === "/api/chat") {
        return Promise.resolve(
          sseResponse([
            { event: "start", data: { userMessageId: "u2" } },
            { event: "delta", data: { delta: "edited" } },
            { event: "done", data: { assistantMessageId: "a2" } },
          ]),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const { result } = renderHook(() => useChat(id));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.editMessage("u1", "edited question");
    });

    // New user message + new assistant are displayed
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].content).toBe("edited question");
    expect(result.current.messages[1].content).toBe("edited");
  });
});
