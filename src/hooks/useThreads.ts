"use client";

import { useCallback, useEffect, useState } from "react";
import { clientFetch } from "@/lib/clientFetch";
import { useI18n } from "@/components/I18nProvider";

export type ThreadSummary = {
  id: string;
  title: string;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * サイドバー用スレッド一覧フック（Phase 5）。
 *
 * - 初回マウントで GET /api/threads を取得。
 * - create() は POST /api/threads で新規スレッドを作り、一覧に先頭挿入。
 * - rename(id, title) は PATCH /api/threads?id=...。
 * - move(id, folderId) は PATCH /api/threads?id=... で folderId を更新。
 * - remove(id) は DELETE /api/threads/[id]。
 * - refresh() で一覧を再取得（チャット送信後に updatedAt 順序を更新するため）。
 */
export function useThreads() {
  const { t } = useI18n();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await clientFetch("/api/threads");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ThreadSummary[];
      setThreads(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sidebar.loadError"));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // 初回ロード。effect 本体で同期的 setState しないよう async IIFE で包む。
  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  const create = useCallback(async (): Promise<ThreadSummary | null> => {
    try {
      const res = await clientFetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const thread = (await res.json()) as ThreadSummary;
      setThreads((prev) => [thread, ...prev]);
      return thread;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sidebar.createError"));
      return null;
    }
  }, [t]);

  const rename = useCallback(async (id: string, title: string): Promise<boolean> => {
    try {
      const res = await clientFetch(`/api/threads?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as ThreadSummary;
      setThreads((prev) => prev.map((th) => (th.id === id ? updated : th)));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sidebar.renameError"));
      return false;
    }
  }, [t]);

  const move = useCallback(async (id: string, folderId: string | null): Promise<boolean> => {
    try {
      const res = await clientFetch(`/api/threads?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as ThreadSummary;
      setThreads((prev) => prev.map((th) => (th.id === id ? updated : th)));
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sidebar.moveError"));
      return false;
    }
  }, [t]);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await clientFetch(`/api/threads/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      setThreads((prev) => prev.filter((th) => th.id !== id));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sidebar.deleteError"));
      return false;
    }
  }, [t]);

  return { threads, isLoading, error, refresh, create, rename, move, remove };
}
