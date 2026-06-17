"use client";

import { useCallback, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ChatWindow } from "@/components/ChatWindow";
import { useThreads } from "@/hooks/useThreads";

/**
 * アプリ全体のシェル。アクティブスレッド状態をここで保持し、
 * Sidebar（一覧 + 選択）と ChatWindow（単一会話）に配る。
 */
export function ChatShell() {
  const { threads, isLoading, error, refresh, create, rename, remove } = useThreads();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  // 初回ロード後、スレッドが1件もなければ自動で1件作成せず空状態を表示する。
  // ユーザが「新規チャット」を押した時に作る。

  const handleNewChat = useCallback(async () => {
    const thread = await create();
    if (thread) {
      setActiveThreadId(thread.id);
      void refresh();
    }
  }, [create, refresh]);

  const handleSelect = useCallback((id: string) => {
    setActiveThreadId(id);
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      const ok = await remove(id);
      if (!ok) return;
      if (activeThreadId === id) {
        setActiveThreadId(null);
      }
      void refresh();
    },
    [remove, activeThreadId, refresh],
  );

  const handleRenamed = useCallback(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <Sidebar
        threads={threads}
        isLoading={isLoading}
        error={error}
        activeThreadId={activeThreadId}
        onSelect={handleSelect}
        onNewChat={handleNewChat}
        onDelete={handleDelete}
        onRename={rename}
        onRenamed={handleRenamed}
      />
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <ChatWindow threadId={activeThreadId} onConversationEnded={handleRenamed} />
      </main>
    </div>
  );
}
