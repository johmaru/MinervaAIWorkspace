"use client";

import { useCallback, useRef, useState } from "react";

export type ChatRole = "user" | "assistant" | "system";
export type ChatMessage = { id: string; role: ChatRole; content: string };

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * 単一スレッドのストリーミングチャット。
 * Phase 1: 永続化なし（state のみ）。
 * Phase 2 で DB 永続化に差し替え。
 */
export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (input: string, opts?: { systemPrompt?: string; model?: string }) => {
      const trimmed = input.trim();
      if (!trimmed || isStreaming) return;

      const userMsg: ChatMessage = { id: uid(), role: "user", content: trimmed };
      const assistantId = uid();
      const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "" };

      // 直前の会話（systemPrompt は API にだけ渡し、UI の messages には user/assistant のみ）
      const history = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

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
            messages: [...history, { role: "user", content: trimmed }],
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

          // SSE イベント区切り "\n\n" で分割
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const event = parseSse(raw);
            if (!event) continue;
            if (event.event === "delta" && event.data?.delta) {
              const delta = event.data.delta as string;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + delta } : m,
                ),
              );
            } else if (event.event === "error") {
              setError(event.data?.message ?? "stream error");
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // 停止: そのまま残す（部分回答保持）
        } else {
          setError(err instanceof Error ? err.message : "fetch error");
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, messages],
  );

  const clear = useCallback(() => {
    if (isStreaming) abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }, [isStreaming]);

  return { messages, isStreaming, error, send, stop, clear };
}

type SseData = { delta?: string; message?: string };

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
