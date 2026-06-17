"use client";

import { useEffect, useRef, useState } from "react";
import { useChat, type ChatMessage } from "@/hooks/useChat";

export function ChatWindow({
  threadId,
  onConversationEnded,
}: {
  threadId: string | null;
  onConversationEnded?: () => void;
}) {
  const { messages, isStreaming, isLoading, error, send, stop } = useChat(threadId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");

  // 自動スクロール
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 入力欄の自動高さ
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  function submit() {
    if (!input.trim() || isStreaming) return;
    void send(input).then(() => {
      onConversationEnded?.();
    });
    setInput("");
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {isLoading && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {messages.length === 0 && !isLoading && (
            threadId ? <EmptyState /> : <NoThreadState />
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} m={m} streaming={isStreaming} />
          ))}
          {error && (
            <p className="text-sm text-red-500">エラー: {error}</p>
          )}
        </div>
      </div>

      <div className="border-t border-border px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder="メッセージを入力（Enter で送信、Shift+Enter で改行）"
            className="min-h-[40px] flex-1 resize-none rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={stop}
              className="h-10 rounded border border-border px-3 text-sm hover:bg-muted"
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!input.trim()}
              className="h-10 rounded bg-accent px-4 text-sm text-accent-foreground disabled:opacity-40"
            >
              送信
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-20 flex flex-col items-center gap-2 text-center text-muted-foreground">
      <p className="text-lg font-semibold">UmansChat</p>
      <p className="text-sm">メッセージを送って会話を始めてください。</p>
    </div>
  );
}

function NoThreadState() {
  return (
    <div className="mt-20 flex flex-col items-center gap-2 text-center text-muted-foreground">
      <p className="text-lg font-semibold">UmansChat</p>
      <p className="text-sm">左の「+ 新規チャット」からスレッドを作成してください。</p>
    </div>
  );
}

function MessageBubble({ m, streaming }: { m: ChatMessage; streaming: boolean }) {
  const isUser = m.role === "user";
  const isStreamingThis = streaming && m.role === "assistant" && m.content === "";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "bg-accent text-accent-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        {m.content || (isStreamingThis ? "…" : "")}
        {!isUser && streaming && m.content && (
          <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground align-middle" />
        )}
      </div>
    </div>
  );
}
