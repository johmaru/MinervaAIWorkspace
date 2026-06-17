"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ChatRole = "user" | "assistant" | "system";
export type ChatMessage = { id: string; role: ChatRole; content: string };

type Thread = {
  id: string;
  title: string;
  systemPrompt: string | null;
  model: string;
};

/**
 * 単一スレッドのストリーミングチャット（Phase 2: DB 永続化）。
 *
 * - threadId を受け取り、初回ロードで GET /api/threads/[id] から
 *   メッセージ履歴を取得して state に展開する。
 * - send(content) は POST /api/chat に { threadId, content } を送り、
 *   SSE で start/delta/done/error を処理する。
 * - ストリーミング中の楽観追加・部分回答保持・停止は Phase 1 と同じ挙動。
 * - Phase 5 で parent_id ツリーに拡張するため、メッセージの parent はまだ扱わない。
 */
export function useChat(threadId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // スレッド切替時にロード。
  // 同期的 setState を effect 本体で行わないよう、リセットは次の
  // 非同期ブロックの先頭にまとめる（React 19 set-state-in-effect 推奨）。
  useEffect(() => {
    if (!threadId) {
      // 何もしない: threadId が null のときは state を空に保つのは
      // コンポーネントの初回レンダリングに任せる。ロードも行わない。
      return;
    }
    let cancelled = false;

    // 全ての setState を非同期コールバック内に置き、effect 本体での
    // 同期 setState を避ける（React 19 set-state-in-effect 推奨）。
    void (async () => {
      setIsLoading(true);
      setError(null);
      setMessages([]);
      setThread(null);
      try {
        const res = await fetch(`/api/threads/${threadId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          thread: Thread;
          messages: { id: string; role: ChatRole; content: string }[];
        };
        if (cancelled) return;
        setThread(data.thread);
        setMessages(data.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load error");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (input: string, opts?: { systemPrompt?: string; model?: string }) => {
      if (!threadId) return;
      const trimmed = input.trim();
      if (!trimmed || isStreaming) return;

      const userMsg: ChatMessage = { id: `optimistic-user-${Date.now()}`, role: "user", content: trimmed };
      const assistantId = `optimistic-assistant-${Date.now()}`;
      const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "" };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setError(null);
      setIsStreaming(true);

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            content: trimmed,
            systemPrompt: opts?.systemPrompt,
            model: opts?.model,
          }),
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const event = parseSse(raw);
            if (!event) continue;

            if (event.event === "start" && event.data?.userMessageId) {
              // 永続化された user メッセージの id で楽観 id を差し替え
              const realId = event.data.userMessageId as string;
              setMessages((prev) =>
                prev.map((m) => (m.id === userMsg.id ? { ...m, id: realId } : m)),
              );
            } else if (event.event === "delta" && event.data?.delta) {
              const delta = event.data.delta as string;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + delta } : m,
                ),
              );
            } else if (event.event === "done" && event.data?.assistantMessageId) {
              const realId = event.data.assistantMessageId as string;
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, id: realId } : m)),
              );
            } else if (event.event === "error") {
              setError(event.data?.message ?? "stream error");
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // 停止: 部分回答をそのまま残す
        } else {
          setError(err instanceof Error ? err.message : "fetch error");
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [threadId, isStreaming],
  );

  const clear = useCallback(() => {
    if (isStreaming) abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }, [isStreaming]);

  return { messages, thread, isStreaming, isLoading, error, send, stop, clear };
}

type SseData = {
  delta?: string;
  message?: string;
  userMessageId?: string;
  assistantMessageId?: string;
};

function parseSse(raw: string): { event: string; data: SseData } | null {
  let event = "message";
  let dataLine = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
  }
  if (!dataLine) return null;
  try {
    return { event, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}
