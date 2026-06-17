"use client";

import Link from "next/link";

export function Sidebar() {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-muted">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="text-sm font-semibold">UmansChat</span>
      </div>

      <div className="px-2">
        <button
          type="button"
          className="w-full rounded border border-border px-2 py-1.5 text-left text-sm hover:bg-background"
        >
          + 新規チャット
        </button>
      </div>

      <nav className="mt-2 flex-1 overflow-y-auto px-1">
        {/* Phase 2 でスレッド一覧を投入 */}
        <p className="px-2 py-4 text-xs text-muted-foreground">
          スレッドがありません
        </p>
      </nav>

      <div className="border-t border-border px-2 py-2 text-xs text-muted-foreground">
        <Link href="/settings">設定</Link>
      </div>
    </aside>
  );
}
