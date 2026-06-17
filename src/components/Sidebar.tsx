"use client";

import { useState } from "react";

import type { ThreadSummary } from "@/hooks/useThreads";

type SidebarProps = {
  threads: ThreadSummary[];
  isLoading: boolean;
  error: string | null;
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<boolean> | boolean;
  onRenamed: () => void;
};

export function Sidebar({
  threads,
  isLoading,
  error,
  activeThreadId,
  onSelect,
  onNewChat,
  onDelete,
  onRename,
  onRenamed,
}: SidebarProps) {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-muted">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="text-sm font-semibold">UmansChat</span>
      </div>

      <div className="px-2">
        <button
          type="button"
          onClick={onNewChat}
          className="w-full rounded border border-border px-2 py-1.5 text-left text-sm hover:bg-background"
        >
          + 新規チャット
        </button>
      </div>

      <nav className="mt-2 flex-1 overflow-y-auto px-1">
        {isLoading && threads.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">読み込み中…</p>
        ) : threads.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">スレッドがありません</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {threads.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                active={t.id === activeThreadId}
                onSelect={() => onSelect(t.id)}
                onDelete={() => onDelete(t.id)}
                onRename={onRename}
                onRenamed={onRenamed}
              />
            ))}
          </ul>
        )}
      </nav>

      {error && (
        <div className="border-t border-border px-2 py-2 text-xs text-red-500">エラー: {error}</div>
      )}
    </aside>
  );
}

type ThreadRowProps = {
  thread: ThreadSummary;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (id: string, title: string) => Promise<boolean> | boolean;
  onRenamed: () => void;
};

function ThreadRow({ thread, active, onSelect, onDelete, onRename, onRenamed }: ThreadRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);

  async function commitRename() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === thread.title) {
      setEditing(false);
      setDraft(thread.title);
      return;
    }
    const ok = await onRename(thread.id, trimmed);
    setEditing(false);
    if (ok) onRenamed();
  }

  if (editing) {
    return (
      <li className="px-1">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitRename();
            } else if (e.key === "Escape") {
              setEditing(false);
              setDraft(thread.title);
            }
          }}
          className="w-full rounded border border-accent bg-background px-2 py-1 text-sm outline-none"
        />
      </li>
    );
  }

  return (
    <li className="group flex items-center gap-1 rounded px-1">
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => {
          setDraft(thread.title);
          setEditing(true);
        }}
        className={`flex-1 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-background ${
          active ? "bg-background font-medium" : ""
        }`}
        title={thread.title}
      >
        {thread.title}
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label="削除"
        className="hidden shrink-0 rounded px-1 text-xs text-muted-foreground hover:bg-background hover:text-red-500 group-hover:block"
      >
        ×
      </button>
    </li>
  );
}
