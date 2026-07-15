"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimateModal, MotionButton } from "@/components/ui/motion";
import { useI18n } from "@/components/I18nProvider";
import { clientFetch } from "@/lib/clientFetch";

type TodoEntry = {
  id: string;
  title: string;
  description: string | null;
  status: "pending" | "in_progress" | "completed";
  priority: "low" | "medium" | "high";
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type FilterType = "all" | "pending" | "completed";

type Props = { open: boolean; onClose: () => void };

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  high: "bg-red-500/15 text-red-600 dark:text-red-400",
};

/**
 * TodoModal — standalone per-user todo list manager.
 * Create / list / update / delete via REST API.
 * Sorted by dueAt asc (nulls last), then createdAt desc (server-side).
 */
export function TodoModal({ open, onClose }: Props) {
  const { t } = useI18n();
  const [todoList, setTodoList] = useState<TodoEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterType>("all");
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [addTitle, setAddTitle] = useState("");
  const [addDescription, setAddDescription] = useState("");
  const [addPriority, setAddPriority] = useState<"low" | "medium" | "high">("medium");
  const [addDueAt, setAddDueAt] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState<"low" | "medium" | "high">("medium");
  const [editDueAt, setEditDueAt] = useState("");

  // Delete confirmation state
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const fetchTodos = useCallback(async () => {
    setLoading(true);
    try {
      const res = await clientFetch("/api/todos");
      if (!res.ok) {
        setError(t("todo.error") !== "todo.error" ? t("todo.error") : "Error");
        return;
      }
      const rows = (await res.json()) as TodoEntry[];
      setTodoList(rows);
      setError(null);
    } catch {
      setError("Error");
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) {
      setPendingDeleteId(null);
      void fetchTodos();
    }
  }, [open, fetchTodos]);

  const filtered = todoList.filter((todo) => {
    if (filter === "pending") return todo.status !== "completed";
    if (filter === "completed") return todo.status === "completed";
    return true;
  });

  const handleAdd = useCallback(async () => {
    if (!addTitle.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: addTitle.trim(),
        priority: addPriority,
      };
      if (addDescription.trim()) body.description = addDescription.trim();
      if (addDueAt) body.dueAt = new Date(addDueAt).toISOString();
      const res = await clientFetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError("Error");
        return;
      }
      setAddTitle("");
      setAddDescription("");
      setAddPriority("medium");
      setAddDueAt("");
      setAddOpen(false);
      setError(null);
      await fetchTodos();
    } catch {
      setError("Error");
    } finally {
      setSaving(false);
    }
  }, [addTitle, addDescription, addPriority, addDueAt, fetchTodos]);

  const handleToggleComplete = useCallback(async (todo: TodoEntry) => {
    const newStatus = todo.status === "completed" ? "pending" : "completed";
    try {
      const res = await clientFetch(`/api/todos/${todo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        setError("Error");
        return;
      }
      setError(null);
      await fetchTodos();
    } catch {
      setError("Error");
    }
  }, [fetchTodos]);

  const handleSaveEdit = useCallback(async () => {
    if (!editingId || !editTitle.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: editTitle.trim(),
        priority: editPriority,
      };
      if (editDescription.trim()) body.description = editDescription.trim();
      else body.description = null;
      if (editDueAt) body.dueAt = new Date(editDueAt).toISOString();
      else body.dueAt = null;
      const res = await clientFetch(`/api/todos/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError("Error");
        return;
      }
      setEditingId(null);
      setError(null);
      await fetchTodos();
    } catch {
      setError("Error");
    } finally {
      setSaving(false);
    }
  }, [editingId, editTitle, editDescription, editPriority, editDueAt, fetchTodos]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      const res = await clientFetch(`/api/todos/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError("Error");
        return;
      }
      setPendingDeleteId(null);
      setError(null);
      await fetchTodos();
    } catch {
      setError("Error");
    }
  }, [fetchTodos]);

  const startEdit = (todo: TodoEntry) => {
    setPendingDeleteId(null);
    setEditingId(todo.id);
    setEditTitle(todo.title);
    setEditDescription(todo.description ?? "");
    setEditPriority(todo.priority);
    setEditDueAt(todo.dueAt ? new Date(todo.dueAt).toISOString().slice(0, 10) : "");
  };

  return (
    <AnimateModal open={open} onClose={onClose} panelClassName="max-w-3xl" ariaLabel={t("todo.title")}>
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("todo.title")}</h2>
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
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterType)}
            className="rounded-xl bg-muted px-3 py-2 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="all">{t("todo.filterAll")}</option>
            <option value="pending">{t("todo.filterPending")}</option>
            <option value="completed">{t("todo.filterCompleted")}</option>
          </select>
          <MotionButton
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className="ml-auto rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-all duration-200 hover:opacity-90"
            whileTap={{ scale: 0.97 }}
          >
            {t("todo.addButton")}
          </MotionButton>
        </div>

        {/* Add form */}
        {addOpen && (
          <div className="flex flex-col gap-3 rounded-xl bg-muted/50 p-3 ring-1 ring-border">
            <input
              type="text"
              value={addTitle}
              onChange={(e) => setAddTitle(e.target.value)}
              placeholder={t("todo.addPlaceholder")}
              className="rounded-lg bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
            />
            <textarea
              value={addDescription}
              onChange={(e) => setAddDescription(e.target.value)}
              placeholder={t("todo.descriptionPlaceholder")}
              rows={2}
              className="rounded-lg bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
            />
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">{t("todo.priority")}</label>
                <select
                  value={addPriority}
                  onChange={(e) => setAddPriority(e.target.value as "low" | "medium" | "high")}
                  className="rounded-lg bg-background px-2 py-1 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="low">{t("todo.priorityLow")}</option>
                  <option value="medium">{t("todo.priorityMedium")}</option>
                  <option value="high">{t("todo.priorityHigh")}</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">{t("todo.dueDate")}</label>
                <input
                  type="date"
                  value={addDueAt}
                  onChange={(e) => setAddDueAt(e.target.value)}
                  className="rounded-lg bg-background px-2 py-1 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <MotionButton
                type="button"
                onClick={handleAdd}
                disabled={!addTitle.trim() || saving}
                className="ml-auto rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all duration-200 hover:opacity-90 disabled:opacity-50"
                whileTap={{ scale: 0.97 }}
              >
                {saving ? t("todo.loading") : t("todo.addButton")}
              </MotionButton>
            </div>
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t("todo.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{t("todo.empty")}</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((todo) => (
              <li
                key={todo.id}
                className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3 ring-1 ring-border"
              >
                {editingId === todo.id ? (
                  // Edit mode
                  <div className="flex flex-col gap-2">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="rounded-lg bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                    />
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      rows={2}
                      className="rounded-lg bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <select
                        value={editPriority}
                        onChange={(e) => setEditPriority(e.target.value as "low" | "medium" | "high")}
                        className="rounded-lg bg-background px-2 py-1 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-primary"
                      >
                        <option value="low">{t("todo.priorityLow")}</option>
                        <option value="medium">{t("todo.priorityMedium")}</option>
                        <option value="high">{t("todo.priorityHigh")}</option>
                      </select>
                      <input
                        type="date"
                        value={editDueAt}
                        onChange={(e) => setEditDueAt(e.target.value)}
                        className="rounded-lg bg-background px-2 py-1 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-primary"
                      />
                      <div className="ml-auto flex gap-2">
                        <MotionButton
                          type="button"
                          onClick={handleSaveEdit}
                          disabled={saving || !editTitle.trim()}
                          className="rounded-lg bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("todo.save")}
                        </MotionButton>
                        <MotionButton
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="rounded-lg bg-muted px-3 py-1 text-sm hover:bg-muted/80"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("todo.cancel")}
                        </MotionButton>
                      </div>
                    </div>
                  </div>
                ) : (
                  // Display mode
                  <>
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleComplete(todo)}
                        className="mt-0.5 shrink-0"
                        aria-label={t("todo.toggleComplete")}
                      >
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded-md border-2 transition-colors ${
                            todo.status === "completed"
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-muted-foreground/30 hover:border-primary"
                          }`}
                        >
                          {todo.status === "completed" && (
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </span>
                      </button>
                      <div className="flex-1">
                        <div className={`text-sm font-medium ${todo.status === "completed" ? "line-through text-muted-foreground" : ""}`}>
                          {todo.title}
                        </div>
                        {todo.description && (
                          <div className="mt-1 text-xs text-muted-foreground">{todo.description}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_COLORS[todo.priority] ?? PRIORITY_COLORS.medium}`}>
                        {todo.priority === "low" ? t("todo.priorityLow") : todo.priority === "high" ? t("todo.priorityHigh") : t("todo.priorityMedium")}
                      </span>
                      <span>·</span>
                      <span>
                        {todo.dueAt
                          ? `${t("todo.dueDate")}: ${new Date(todo.dueAt).toLocaleDateString()}`
                          : t("todo.noDueDate")}
                      </span>
                      {todo.status === "completed" && todo.completedAt && (
                        <>
                          <span>·</span>
                          <span>{new Date(todo.completedAt).toLocaleDateString()}</span>
                        </>
                      )}
                      <div className="ml-auto flex gap-1">
                        <MotionButton
                          type="button"
                          onClick={() => startEdit(todo)}
                          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={t("todo.edit")}
                          whileTap={{ scale: 0.9 }}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </MotionButton>
                        {pendingDeleteId === todo.id ? (
                          <>
                            <MotionButton
                              type="button"
                              onClick={() => handleDelete(todo.id)}
                              className="rounded-lg bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-500/25 dark:text-red-400"
                              whileTap={{ scale: 0.97 }}
                            >
                              {t("todo.deleteConfirmYes")}
                            </MotionButton>
                            <MotionButton
                              type="button"
                              onClick={() => setPendingDeleteId(null)}
                              className="rounded-lg bg-muted px-2.5 py-1 text-xs hover:bg-muted/80"
                              whileTap={{ scale: 0.97 }}
                            >
                              {t("todo.cancel")}
                            </MotionButton>
                          </>
                        ) : (
                          <MotionButton
                            type="button"
                            onClick={() => setPendingDeleteId(todo.id)}
                            className="rounded-lg p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                            aria-label={t("todo.delete")}
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
