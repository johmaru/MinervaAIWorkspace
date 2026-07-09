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
 * Thread list hook for the sidebar (Phase 5).
 *
 * - Fetches GET /api/threads on initial mount.
 * - create() does POST /api/threads to create a new thread, inserted at the top of the list.
 * - rename(id, title) does PATCH /api/threads?id=...
 * - move(id, folderId) does PATCH /api/threads?id=... to update folderId.
 * - remove(id) does DELETE /api/threads/[id].
 * - refresh() re-fetches the list (to update updatedAt ordering after sending a chat).
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

  // Initial load. Wrapped in an async IIFE to avoid synchronous setState in the effect body.
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
