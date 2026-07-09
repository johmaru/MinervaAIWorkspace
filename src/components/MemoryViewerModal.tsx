"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimateModal, MotionButton } from "@/components/ui/motion";
import { useI18n } from "@/components/I18nProvider";
import { clientFetch } from "@/lib/clientFetch";

type MemoryEntry = {
  id: string;
  threadId: string;
  threadTitle: string;
  kind: "fact" | "working";
  content: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
};

type ThreadRow = {
  id: string;
  title: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * MemoryViewerModal — viewer/editor for the memories table.
 * List display + search/filter + edit (PATCH) + delete (logical) + add (POST).
 * Targets only the memories table (page_embeddings are excluded).
 */
export function MemoryViewerModal({ open, onClose }: Props) {
  const { t } = useI18n();
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "fact" | "working">("all");
  const [search, setSearch] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editKind, setEditKind] = useState<"fact" | "working">("fact");
  const [editImportance, setEditImportance] = useState(0.5);
  const [saving, setSaving] = useState(false);

  // Delete confirmation state
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Add state
  const [addOpen, setAddOpen] = useState(false);
  const [addContent, setAddContent] = useState("");
  const [addKind, setAddKind] = useState<"fact" | "working">("fact");
  const [addImportance, setAddImportance] = useState(0.5);
  const [addThreadId, setAddThreadId] = useState<string | null>(null);
  const [addThreadTitle, setAddThreadTitle] = useState("");

  const [error, setError] = useState<string | null>(null);

  const fetchMemories = useCallback(async () => {
    setLoading(true);
    try {
      const res = await clientFetch("/api/memories");
      if (!res.ok) {
        setError(t("memoryViewer.error"));
        return;
      }
      setMemories((await res.json()) as MemoryEntry[]);
      setError(null);
    } catch {
      setError(t("memoryViewer.error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Fetch memory list + latest threads when modal opens
  useEffect(() => {
    if (!open) return;
    setPendingDeleteId(null);
    void fetchMemories();
    void clientFetch("/api/threads")
      .then((res) => res.json())
      .then((rows: ThreadRow[]) => {
        const active = rows[0];
        setAddThreadId(active?.id ?? null);
        setAddThreadTitle(active?.title ?? "");
      })
      .catch(() => {
        setAddThreadId(null);
        setAddThreadTitle("");
      });
  }, [open, fetchMemories]);

  const filtered = memories.filter(
    (m) =>
      (filter === "all" || m.kind === filter) &&
      (search === "" || m.content.toLowerCase().includes(search.toLowerCase())),
  );

  const startEdit = (m: MemoryEntry) => {
    setPendingDeleteId(null);
    setEditingId(m.id);
    setEditContent(m.content);
    setEditKind(m.kind);
    setEditImportance(m.importance);
  };

  const handleSave = useCallback(async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      const res = await clientFetch(`/api/memories/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: editContent.trim(),
          kind: editKind,
          importance: editImportance,
        }),
      });
      if (!res.ok) {
        setError(t("memoryViewer.error"));
        return;
      }
      setEditingId(null);
      setError(null);
      await fetchMemories();
    } catch {
      setError(t("memoryViewer.error"));
    } finally {
      setSaving(false);
    }
  }, [editingId, editContent, editKind, editImportance, fetchMemories, t]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const res = await clientFetch(`/api/memories/${id}`, { method: "DELETE" });
        if (!res.ok) {
          setError(t("memoryViewer.error"));
          return;
        }
        setError(null);
        setPendingDeleteId(null);
        await fetchMemories();
      } catch {
        setError(t("memoryViewer.error"));
      }
    },
    [fetchMemories, t],
  );

  const handleAdd = useCallback(async () => {
    if (!addContent.trim() || !addThreadId) return;
    setSaving(true);
    try {
      const res = await clientFetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: addContent.trim(),
          kind: addKind,
          importance: addImportance,
          threadId: addThreadId,
        }),
      });
      if (!res.ok) {
        setError(t("memoryViewer.error"));
        return;
      }
      setAddContent("");
      setAddOpen(false);
      setError(null);
      await fetchMemories();
    } catch {
      setError(t("memoryViewer.error"));
    } finally {
      setSaving(false);
    }
  }, [addContent, addKind, addImportance, addThreadId, fetchMemories, t]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <AnimateModal open={open} onClose={onClose} panelClassName="max-w-3xl" ariaLabel={t("memoryViewer.title")}>
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("memoryViewer.title")}</h2>
          <MotionButton
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
            aria-label={t("common.cancel")}
            whileTap={{ scale: 0.9 }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </MotionButton>
        </div>

        {error && (
          <div className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>
        )}

        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("memoryViewer.search")}
            className="flex-1 rounded-xl bg-muted px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as "all" | "fact" | "working")}
            className="rounded-xl bg-muted px-3 py-2 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="all">{t("memoryViewer.filterAll")}</option>
            <option value="fact">{t("memoryViewer.filterFact")}</option>
            <option value="working">{t("memoryViewer.filterWorking")}</option>
          </select>
          <MotionButton
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className="rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-all duration-200 hover:opacity-90 disabled:opacity-50"
            whileTap={{ scale: 0.97 }}
          >
            {t("memoryViewer.add")}
          </MotionButton>
        </div>

        {/* Add form */}
        {addOpen && (
          <div className="flex flex-col gap-3 rounded-xl bg-muted/50 p-3 ring-1 ring-border">
            <textarea
              value={addContent}
              onChange={(e) => setAddContent(e.target.value)}
              placeholder={t("memoryViewer.addContentPlaceholder")}
              rows={3}
              className="rounded-lg bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
            />
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">{t("memoryViewer.kind")}</label>
                <select
                  value={addKind}
                  onChange={(e) => setAddKind(e.target.value as "fact" | "working")}
                  className="rounded-lg bg-background px-2 py-1 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="fact">{t("memoryViewer.fact")}</option>
                  <option value="working">{t("memoryViewer.working")}</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">{t("memoryViewer.importance")}</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={addImportance}
                  onChange={(e) => setAddImportance(Number(e.target.value))}
                  className="w-32"
                />
                <span className="text-xs tabular-nums text-muted-foreground">{Math.round(addImportance * 100)}%</span>
              </div>
              <div className="ml-auto text-xs text-muted-foreground">
                {addThreadId ? (
                  <>
                    {t("memoryViewer.thread")}: {addThreadTitle || addThreadId}
                  </>
                ) : (
                  t("memoryViewer.noThread")
                )}
              </div>
            </div>
            <MotionButton
              type="button"
              onClick={handleAdd}
              disabled={!addContent.trim() || !addThreadId || saving}
              className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all duration-200 hover:opacity-90 disabled:opacity-50"
              whileTap={{ scale: 0.97 }}
            >
              {saving ? t("memoryViewer.loading") : t("memoryViewer.add")}
            </MotionButton>
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t("memoryViewer.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t("memoryViewer.empty")}</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((m) => (
              <li
                key={m.id}
                className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3 ring-1 ring-border"
              >
                {editingId === m.id ? (
                  // Edit mode
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={3}
                      className="rounded-lg bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <select
                        value={editKind}
                        onChange={(e) => setEditKind(e.target.value as "fact" | "working")}
                        className="rounded-lg bg-background px-2 py-1 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-primary"
                      >
                        <option value="fact">{t("memoryViewer.fact")}</option>
                        <option value="working">{t("memoryViewer.working")}</option>
                      </select>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.1}
                          value={editImportance}
                          onChange={(e) => setEditImportance(Number(e.target.value))}
                          className="w-32"
                        />
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {Math.round(editImportance * 100)}%
                        </span>
                      </div>
                      <div className="ml-auto flex gap-2">
                        <MotionButton
                          type="button"
                          onClick={handleSave}
                          disabled={saving}
                          className="rounded-lg bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("memoryViewer.save")}
                        </MotionButton>
                        <MotionButton
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="rounded-lg bg-muted px-3 py-1 text-sm hover:bg-muted/80"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("memoryViewer.cancel")}
                        </MotionButton>
                      </div>
                    </div>
                  </div>
                ) : (
                  // Display mode
                  <>
                    <div className="flex items-start gap-2">
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                          m.kind === "fact"
                            ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                            : "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                        }`}
                      >
                        {m.kind === "fact" ? t("memoryViewer.fact") : t("memoryViewer.working")}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleExpand(m.id)}
                        className={`flex-1 text-left text-sm ${
                          expandedIds.has(m.id) ? "" : "line-clamp-2"
                        }`}
                      >
                        {m.content}
                      </button>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{m.threadTitle}</span>
                      <span>·</span>
                      <span>{Math.round(m.importance * 100)}%</span>
                      <span>·</span>
                      <span>{new Date(m.updatedAt).toLocaleString()}</span>
                      <div className="ml-auto flex gap-1">
                        <MotionButton
                          type="button"
                          onClick={() => startEdit(m)}
                          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={t("memoryViewer.edit")}
                          whileTap={{ scale: 0.9 }}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </MotionButton>
                        {pendingDeleteId === m.id ? (
                          <>
                            <MotionButton
                              type="button"
                              onClick={() => handleDelete(m.id)}
                              className="rounded-lg bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-500/25 dark:text-red-400"
                              whileTap={{ scale: 0.97 }}
                            >
                              {t("memoryViewer.deleteConfirmYes")}
                            </MotionButton>
                            <MotionButton
                              type="button"
                              onClick={() => setPendingDeleteId(null)}
                              className="rounded-lg bg-muted px-2.5 py-1 text-xs hover:bg-muted/80"
                              whileTap={{ scale: 0.97 }}
                            >
                              {t("memoryViewer.cancel")}
                            </MotionButton>
                          </>
                        ) : (
                          <MotionButton
                            type="button"
                            onClick={() => setPendingDeleteId(m.id)}
                            className="rounded-lg p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                            aria-label={t("memoryViewer.delete")}
                            whileTap={{ scale: 0.9 }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </MotionButton>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </AnimateModal>
  );
}
