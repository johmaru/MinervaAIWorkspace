"use client";

import { useCallback, useEffect, useState } from "react";

export type ThreadSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * サイドバー用スレッド一覧フック（Phase 2）。
 *
 * - 初回マウントで GET /api/threads を取得。
 * - create() は POST /api/threads で新規スレッドを作り、一覧に先頭挿入。
 * - rename(id, title) は PATCH /api/threads?id=...。
 * - remove(id) は DELETE /api/threads/[id]。
 * - refresh() で一覧を再取得（チャット送信後に updatedAt 順序を更新するため）。
 *
 * SWR / React Query はまだ未導入なので最小の state + fetch で実装する。
 * Phase 2 の PLAN に「楽観更新（useSWR / React Query）」とあるが、
 * まずは正確な実装を優先し、ライブラリ導入は最適化フェーズで検討する。
 */
export function useThreads() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/threads");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ThreadSummary[];
      setThreads(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load error");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 初回ロード。effect 本体で同期的 setState しないよう async IIFE で包む。
  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  const create = useCallback(async (): Promise<ThreadSummary | null> => {
    try {
      const res = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const thread = (await res.json()) as ThreadSummary;
      setThreads((prev) => [thread, ...prev]);
      return thread;
    } catch (err) {
      setError(err instanceof Error ? err.message : "create error");
      return null;
    }
  }, []);

  const rename = useCallback(async (id: string, title: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/threads?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as ThreadSummary;
      setThreads((prev) => prev.map((t) => (t.id === id ? updated : t)));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "rename error");
      return false;
    }
  }, []);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/threads/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      setThreads((prev) => prev.filter((t) => t.id !== id));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete error");
      return false;
    }
  }, []);

  return { threads, isLoading, error, refresh, create, rename, remove };
}
