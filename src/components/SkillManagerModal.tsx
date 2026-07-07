"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimateModal, MotionButton } from "@/components/ui/motion";
import { useI18n } from "@/components/I18nProvider";
import { clientFetch } from "@/lib/clientFetch";

type Skill = {
  id: string;
  name: string;
  content: string;
  kind: string;
  trigger: string | null;
  tags: string[];
  status: string;
  version: number;
  lastUsedAt: string | null;
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
};

type Candidate = {
  id: string;
  threadId: string | null;
  proposedName: string;
  proposedKind: string;
  proposedTrigger: string;
  proposedContent: string;
  proposedTags: string[];
  confidence: number;
  reason: string | null;
  status: string;
  createdAt: string;
};

type Tab = "active" | "drafts" | "archived";

type Props = {
  open: boolean;
  onClose: () => void;
};

const KINDS = ["workflow", "bugfix", "project_rule", "tool_usage", "coding_pattern", "debugging"] as const;

/**
 * SkillManagerModal — skills テーブル + skill_candidates の管理 UI。
 * 3タブ: Active Skills / Draft Candidates / Archived
 * MemoryViewerModal と同じパターン（AnimateModal, clientFetch, useI18n）。
 */
export function SkillManagerModal({ open, onClose }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("active");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [archived, setArchived] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 編集状態
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editKind, setEditKind] = useState<string>("workflow");
  const [editTrigger, setEditTrigger] = useState("");
  const [editTags, setEditTags] = useState("");
  const [saving, setSaving] = useState(false);

  // 候補編集状態
  const [editingCandidateId, setEditingCandidateId] = useState<string | null>(null);
  const [candName, setCandName] = useState("");
  const [candKind, setCandKind] = useState<string>("workflow");
  const [candTrigger, setCandTrigger] = useState("");
  const [candTags, setCandTags] = useState("");
  const [candContent, setCandContent] = useState("");

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [activeRes, draftRes, archivedRes] = await Promise.all([
        clientFetch("/api/skills"),
        clientFetch("/api/skill-candidates?status=draft"),
        clientFetch("/api/skills"),
      ]);
      if (!activeRes.ok || !draftRes.ok || !archivedRes.ok) {
        setError(t("skills.error"));
        return;
      }
      const allSkills = (await activeRes.json()) as Skill[];
      setSkills(allSkills.filter((s) => s.status === "active"));
      setArchived(allSkills.filter((s) => s.status === "archived"));
      setCandidates((await draftRes.json()) as Candidate[]);
    } catch {
      setError(t("skills.error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) fetchAll();
  }, [open, fetchAll]);

  const startEdit = (s: Skill) => {
    setEditingId(s.id);
    setEditName(s.name);
    setEditContent(s.content);
    setEditKind(s.kind);
    setEditTrigger(s.trigger ?? "");
    setEditTags(s.tags.join(", "));
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await clientFetch(`/api/skills/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName,
          content: editContent,
          kind: editKind,
          trigger: editTrigger,
          tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) {
        setError(t("skills.error"));
        return;
      }
      setEditingId(null);
      await fetchAll();
    } catch {
      setError(t("skills.error"));
    } finally {
      setSaving(false);
    }
  }, [editingId, editName, editContent, editKind, editTrigger, editTags, fetchAll, t]);

  const handleArchive = useCallback(async (id: string) => {
    setError(null);
    try {
      const res = await clientFetch(`/api/skills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      });
      if (!res.ok) {
        setError(t("skills.error"));
        return;
      }
      await fetchAll();
    } catch {
      setError(t("skills.error"));
    }
  }, [fetchAll, t]);

  const handleRestore = useCallback(async (id: string) => {
    setError(null);
    try {
      const res = await clientFetch(`/api/skills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      if (!res.ok) {
        setError(t("skills.error"));
        return;
      }
      await fetchAll();
    } catch {
      setError(t("skills.error"));
    }
  }, [fetchAll, t]);

  const handleApprove = useCallback(async (id: string) => {
    setError(null);
    try {
      const res = await clientFetch(`/api/skill-candidates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      if (!res.ok) {
        setError(t("skills.error"));
        return;
      }
      await fetchAll();
    } catch {
      setError(t("skills.error"));
    }
  }, [fetchAll, t]);

  const handleEditAndApprove = useCallback(async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await clientFetch(`/api/skill-candidates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "approved",
          proposedName: candName,
          proposedKind: candKind,
          proposedTrigger: candTrigger,
          proposedTags: candTags.split(",").map((t) => t.trim()).filter(Boolean),
          proposedContent: candContent,
        }),
      });
      if (!res.ok) {
        setError(t("skills.error"));
        return;
      }
      setEditingCandidateId(null);
      await fetchAll();
    } catch {
      setError(t("skills.error"));
    } finally {
      setSaving(false);
    }
  }, [candName, candKind, candTrigger, candTags, candContent, fetchAll, t]);

  const handleReject = useCallback(async (id: string) => {
    setError(null);
    try {
      const res = await clientFetch(`/api/skill-candidates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "rejected" }),
      });
      if (!res.ok) {
        setError(t("skills.error"));
        return;
      }
      await fetchAll();
    } catch {
      setError(t("skills.error"));
    }
  }, [fetchAll, t]);

  const startCandidateEdit = (c: Candidate) => {
    setEditingCandidateId(c.id);
    setCandName(c.proposedName);
    setCandKind(c.proposedKind);
    setCandTrigger(c.proposedTrigger);
    setCandTags(c.proposedTags.join(", "));
    setCandContent(c.proposedContent);
  };

  return (
    <AnimateModal open={open} onClose={onClose} panelClassName="max-w-3xl" ariaLabel={t("skills.managerTitle")}>
      <div className="flex flex-col gap-4">
        {/* ヘッダ */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("skills.managerTitle")}</h2>
          <MotionButton
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground"
            aria-label={t("skills.cancel")}
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

        {/* タブ */}
        <div className="flex gap-2">
          {(["active", "drafts", "archived"] as Tab[]).map((tb) => (
            <button
              key={tb}
              type="button"
              onClick={() => setTab(tb)}
              className={`rounded-xl px-3 py-1.5 text-sm font-medium transition-all duration-200 ${
                tab === tb
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {t(`skills.${tb}`)}
              {tb === "drafts" && candidates.length > 0 && (
                <span className="ml-1.5 rounded-full bg-primary-foreground/20 px-1.5 text-xs">
                  {candidates.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading && <p className="text-sm text-muted-foreground">{t("skills.loading")}</p>}

        {/* Active Skills タブ */}
        {tab === "active" && !loading && (
          <div className="flex flex-col gap-2">
            {skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("skills.noSkills")}</p>
            ) : (
              skills.map((s) => (
                <div key={s.id} className="rounded-xl bg-muted/50 p-3 ring-1 ring-border">
                  {editingId === s.id ? (
                    <div className="flex flex-col gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="rounded-lg bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                      />
                      <div className="flex flex-wrap gap-2">
                        <select
                          value={editKind}
                          onChange={(e) => setEditKind(e.target.value)}
                          className="rounded-lg bg-background px-2 py-1 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-primary"
                        >
                          {KINDS.map((k) => (
                            <option key={k} value={k}>{k}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={editTrigger}
                          onChange={(e) => setEditTrigger(e.target.value)}
                          placeholder={t("skills.trigger")}
                          className="flex-1 rounded-lg bg-background px-2 py-1 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                        />
                      </div>
                      <input
                        type="text"
                        value={editTags}
                        onChange={(e) => setEditTags(e.target.value)}
                        placeholder={`${t("skills.tags")} (comma-separated)`}
                        className="rounded-lg bg-background px-2 py-1 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                      />
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        rows={3}
                        className="rounded-lg bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                      />
                      <div className="flex gap-2">
                        <MotionButton
                          type="button"
                          onClick={handleSave}
                          disabled={saving}
                          className="rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("skills.save")}
                        </MotionButton>
                        <MotionButton
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="rounded-xl bg-muted px-3 py-1.5 text-sm hover:opacity-80"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("skills.cancel")}
                        </MotionButton>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{s.name}</span>
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{s.kind}</span>
                        </div>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => startEdit(s)}
                            className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            {t("skills.edit")}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleArchive(s.id)}
                            className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            {t("skills.archive")}
                          </button>
                        </div>
                      </div>
                      {s.trigger && (
                        <p className="text-xs text-muted-foreground">⟶ {s.trigger}</p>
                      )}
                      {s.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {s.tags.map((tag) => (
                            <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-xs">{tag}</span>
                          ))}
                        </div>
                      )}
                      <p className="text-sm text-muted-foreground">{s.content}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("skills.lastUsed")}:{" "}
                        {s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleDateString() : t("skills.never")}
                      </p>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Draft Candidates タブ */}
        {tab === "drafts" && !loading && (
          <div className="flex flex-col gap-2">
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("skills.noCandidates")}</p>
            ) : (
              candidates.map((c) => (
                <div key={c.id} className="rounded-xl bg-muted/50 p-3 ring-1 ring-border">
                  {editingCandidateId === c.id ? (
                    <div className="flex flex-col gap-2">
                      <input
                        type="text"
                        value={candName}
                        onChange={(e) => setCandName(e.target.value)}
                        className="rounded-lg bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                      />
                      <div className="flex gap-2">
                        <select
                          value={candKind}
                          onChange={(e) => setCandKind(e.target.value)}
                          className="rounded-lg bg-background px-2 py-1 text-sm ring-1 ring-border outline-none focus:ring-2 focus:ring-primary"
                        >
                          {KINDS.map((k) => (
                            <option key={k} value={k}>{k}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={candTrigger}
                          onChange={(e) => setCandTrigger(e.target.value)}
                          placeholder={t("skills.trigger")}
                          className="flex-1 rounded-lg bg-background px-2 py-1 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                        />
                      </div>
                      <input
                        type="text"
                        value={candTags}
                        onChange={(e) => setCandTags(e.target.value)}
                        placeholder={`${t("skills.tags")} (comma-separated)`}
                        className="rounded-lg bg-background px-2 py-1 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                      />
                      <textarea
                        value={candContent}
                        onChange={(e) => setCandContent(e.target.value)}
                        rows={3}
                        className="rounded-lg bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-primary"
                      />
                      <div className="flex gap-2">
                        <MotionButton
                          type="button"
                          onClick={() => handleEditAndApprove(c.id)}
                          disabled={saving}
                          className="rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("skills.save")}
                        </MotionButton>
                        <MotionButton
                          type="button"
                          onClick={() => setEditingCandidateId(null)}
                          className="rounded-xl bg-muted px-3 py-1.5 text-sm hover:opacity-80"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("skills.cancel")}
                        </MotionButton>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{c.proposedName}</span>
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{c.proposedKind}</span>
                          <span className="text-xs text-muted-foreground">
                            {t("skills.confidence")}: {Math.round(c.confidence * 100)}%
                          </span>
                        </div>
                      </div>
                      {c.proposedTrigger && (
                        <p className="text-xs text-muted-foreground">⟶ {c.proposedTrigger}</p>
                      )}
                      {c.reason && (
                        <p className="text-xs text-muted-foreground italic">{c.reason}</p>
                      )}
                      <p className="text-sm text-muted-foreground">{c.proposedContent}</p>
                      <div className="flex gap-1 pt-1">
                        <MotionButton
                          type="button"
                          onClick={() => handleApprove(c.id)}
                          className="rounded-xl bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("skills.approve")}
                        </MotionButton>
                        <MotionButton
                          type="button"
                          onClick={() => startCandidateEdit(c)}
                          className="rounded-xl bg-muted px-3 py-1 text-xs hover:opacity-80"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("skills.editAndApprove")}
                        </MotionButton>
                        <MotionButton
                          type="button"
                          onClick={() => handleReject(c.id)}
                          className="rounded-xl bg-muted px-3 py-1 text-xs text-muted-foreground hover:opacity-80"
                          whileTap={{ scale: 0.97 }}
                        >
                          {t("skills.reject")}
                        </MotionButton>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Archived タブ */}
        {tab === "archived" && !loading && (
          <div className="flex flex-col gap-2">
            {archived.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("skills.noArchived")}</p>
            ) : (
              archived.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-xl bg-muted/50 p-3 ring-1 ring-border">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-muted-foreground">{s.name}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{s.kind}</span>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">{s.content}</p>
                  </div>
                  <MotionButton
                    type="button"
                    onClick={() => handleRestore(s.id)}
                    className="rounded-xl bg-muted px-3 py-1.5 text-xs hover:opacity-80"
                    whileTap={{ scale: 0.97 }}
                  >
                    {t("skills.restore")}
                  </MotionButton>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </AnimateModal>
  );
}
