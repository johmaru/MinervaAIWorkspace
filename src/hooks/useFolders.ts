"use client";

import { useCallback, useEffect, useState } from "react";
import { clientFetch } from "@/lib/clientFetch";
import { useI18n } from "@/components/I18nProvider";

export type FolderSummary = {
  id: string;
  name: string;
  instruction: string | null;
  memoryScope: "folder" | "global";
  createdAt: string;
  updatedAt: string;
};

type CreateBody = {
  name?: string;
  instruction?: string | null;
  memoryScope?: "folder" | "global";
};

type PatchBody = {
  name?: string;
  instruction?: string | null;
  memoryScope?: "folder" | "global";
};

/**
 * Folder list hook. Same structure as useThreads.
 *
 * - Fetches GET /api/folders on initial mount.
 * - create(body?) does POST /api/folders → inserts at the top. Returns FolderSummary | null.
 * - update(id, patch) does PATCH /api/folders?id=... → reflects in the list.
 * - remove(id) does DELETE /api/folders/[id].
 * - refresh() re-fetches the list.
 */
export function useFolders() {
  const { t } = useI18n();
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await clientFetch("/api/folders");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as FolderSummary[];
      setFolders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("sidebar.folderLoadError"));
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

  const create = useCallback(
    async (body?: CreateBody): Promise<FolderSummary | null> => {
      try {
        const res = await clientFetch("/api/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const folder = (await res.json()) as FolderSummary;
        setFolders((prev) => [folder, ...prev]);
        setError(null);
        return folder;
      } catch (err) {
        setError(err instanceof Error ? err.message : t("sidebar.folderCreateError"));
        return null;
      }
    },
    [t],
  );

  const update = useCallback(
    async (id: string, patch: PatchBody): Promise<boolean> => {
      try {
        const res = await clientFetch(`/api/folders?id=${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const updated = (await res.json()) as FolderSummary;
        setFolders((prev) => prev.map((f) => (f.id === id ? updated : f)));
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : t("sidebar.folderUpdateError"));
        return false;
      }
    },
    [t],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await clientFetch(`/api/folders/${id}`, { method: "DELETE" });
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
        setFolders((prev) => prev.filter((f) => f.id !== id));
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : t("sidebar.folderDeleteError"));
        return false;
      }
    },
    [t],
  );

  return { folders, isLoading, error, refresh, create, update, remove };
}
