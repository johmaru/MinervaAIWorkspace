"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimateModal, MotionButton } from "@/components/ui/motion";
import { useI18n } from "@/components/I18nProvider";
import { clientFetch } from "@/lib/clientFetch";

type KnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
};

type Document = {
  id: string;
  title: string;
  sourceType: "file" | "url" | "text";
  sourceUrl: string | null;
  chunkCount: number;
  createdAt: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  selectedKbIds: string[];
  onChange: (ids: string[]) => void;
};

/**
 * KnowledgeBaseModal — manage RAG knowledge bases.
 *
 * Two panes:
 * 1. KB list with create/delete + thread toggle (checkbox)
 * 2. Selected KB's documents with add (text/url/file) + delete
 *
 * Toggling a KB checkbox updates thread.activeKbIds via the onChange callback.
 */
export function KnowledgeBaseModal({ open, onClose, selectedKbIds, onChange }: Props) {
  const { t } = useI18n();
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);

  // Create form
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);

  // Document ingest form
  const [docOpen, setDocOpen] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [docSourceType, setDocSourceType] = useState<"text" | "url" | "file">("text");
  const [docContent, setDocContent] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [docFile, setDocFile] = useState<File | null>(null);
  const [ingesting, setIngesting] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const fetchKbs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientFetch("/api/knowledge-bases");
      if (res.ok) {
        setKbs(await res.json());
      }
    } catch {
      setError("Fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDocuments = useCallback(async (kbId: string) => {
    setDocsLoading(true);
    try {
      const res = await clientFetch(`/api/knowledge-bases/${kbId}/documents`);
      if (res.ok) {
        setDocuments(await res.json());
      }
    } catch {
      // ignore
    } finally {
      setDocsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void fetchKbs();
  }, [open, fetchKbs]);

  useEffect(() => {
    if (selectedKbId) void fetchDocuments(selectedKbId);
    else setDocuments([]);
  }, [selectedKbId, fetchDocuments]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const res = await clientFetch("/api/knowledge-bases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: newDescription.trim() || undefined }),
      });
      if (res.ok) {
        setNewName("");
        setNewDescription("");
        setCreateOpen(false);
        await fetchKbs();
      } else {
        setError("Create failed");
      }
    } catch {
      setError("Create failed");
    } finally {
      setCreating(false);
    }
  }, [newName, newDescription, fetchKbs]);

  const handleDelete = useCallback(async (kbId: string) => {
    if (!confirm(t("chat.knowledgeBaseDeleteConfirm"))) return;
    try {
      const res = await clientFetch(`/api/knowledge-bases/${kbId}`, { method: "DELETE" });
      if (res.ok) {
        // Remove from selected if present
        onChange(selectedKbIds.filter((id) => id !== kbId));
        if (selectedKbId === kbId) setSelectedKbId(null);
        await fetchKbs();
      }
    } catch {
      setError("Delete failed");
    }
  }, [selectedKbIds, selectedKbId, onChange, fetchKbs, t]);

  const handleToggle = useCallback((kbId: string) => {
    onChange(
      selectedKbIds.includes(kbId)
        ? selectedKbIds.filter((id) => id !== kbId)
        : [...selectedKbIds, kbId],
    );
  }, [selectedKbIds, onChange]);

  const handleIngest = useCallback(async () => {
    if (!selectedKbId) return;
    const title = docTitle.trim();
    if (!title) return;
    if (docSourceType === "text" && !docContent.trim()) return;
    if (docSourceType === "url" && !docUrl.trim()) return;
    if (docSourceType === "file" && !docFile) return;

    setIngesting(true);
    setError(null);
    try {
      // For text: send JSON with content directly.
      // For url: send JSON with sourceUrl only — server scrapes internally.
      // For file: send multipart/form-data — server extracts text internally.
      let res: Response;
      if (docSourceType === "file" && docFile) {
        const formData = new FormData();
        formData.append("title", title);
        formData.append("sourceType", "file");
        formData.append("file", docFile);
        res = await clientFetch(`/api/knowledge-bases/${selectedKbId}/documents`, {
          method: "POST",
          body: formData,
        });
      } else {
        const body: Record<string, string> = { title, sourceType: docSourceType };
        if (docSourceType === "url") {
          body.sourceUrl = docUrl.trim();
        } else {
          body.content = docContent.trim();
        }
        res = await clientFetch(`/api/knowledge-bases/${selectedKbId}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (res.ok) {
        setDocTitle("");
        setDocContent("");
        setDocUrl("");
        setDocFile(null);
        setDocOpen(false);
        await fetchDocuments(selectedKbId);
        await fetchKbs();
      } else {
        const text = await res.text();
        setError(text || "Ingest failed");
      }
    } catch {
      setError("Ingest failed");
    } finally {
      setIngesting(false);
    }
  }, [selectedKbId, docTitle, docContent, docUrl, docFile, docSourceType, fetchDocuments, fetchKbs]);

  const handleDeleteDoc = useCallback(async (docId: string) => {
    if (!selectedKbId) return;
    try {
      const res = await clientFetch(
        `/api/knowledge-bases/${selectedKbId}/documents?docId=${docId}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        await fetchDocuments(selectedKbId);
        await fetchKbs();
      }
    } catch {
      setError("Delete failed");
    }
  }, [selectedKbId, fetchDocuments, fetchKbs]);

  return (
    <AnimateModal open={open} onClose={onClose} ariaLabel={t("chat.knowledgeBaseManage")} panelClassName="max-w-3xl">
      <div className="flex flex-col gap-4">
        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        {/* KB List */}
        <div className="space-y-1">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : kbs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("chat.knowledgeBaseNoKbs")}</p>
          ) : (
            kbs.map((kb) => (
              <div key={kb.id} className="rounded-lg border border-border/50">
                <div className="flex items-center gap-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selectedKbIds.includes(kb.id)}
                    onChange={() => handleToggle(kb.id)}
                    className="h-4 w-4"
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedKbId(selectedKbId === kb.id ? null : kb.id)}
                    className="flex-1 text-left"
                  >
                    <span className="font-medium">{kb.name}</span>
                    {kb.description && (
                      <span className="ml-2 text-xs text-muted-foreground">{kb.description}</span>
                    )}
                  </button>
                  <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium">
                    {kb.documentCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleDelete(kb.id)}
                    className="text-xs text-destructive hover:underline"
                  >
                    {t("chat.knowledgeBaseDelete")}
                  </button>
                </div>

                {/* Documents pane (expanded when this KB is selected) */}
                {selectedKbId === kb.id && (
                  <div className="border-t border-border/50 px-3 py-2">
                    {docsLoading ? (
                      <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
                    ) : documents.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("chat.knowledgeBaseNoDocuments")}</p>
                    ) : (
                      <ul className="space-y-1">
                        {documents.map((doc) => (
                          <li key={doc.id} className="flex items-center gap-2 text-xs">
                            <span className="flex-1 truncate">{doc.title}</span>
                            <span className="text-muted-foreground">
                              {t("chat.knowledgeBaseChunks").replace("{count}", String(doc.chunkCount))}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleDeleteDoc(doc.id)}
                              className="text-destructive hover:underline"
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* Add document form */}
                    {!docOpen ? (
                      <button
                        type="button"
                        onClick={() => setDocOpen(true)}
                        className="mt-2 text-xs text-primary hover:underline"
                      >
                        + {t("chat.knowledgeBaseAddDocument")}
                      </button>
                    ) : (
                      <div className="mt-2 space-y-2 rounded-lg bg-muted/30 p-2">
                        <input
                          type="text"
                          placeholder={t("chat.knowledgeBaseDocTitle")}
                          value={docTitle}
                          onChange={(e) => setDocTitle(e.target.value)}
                          className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
                        />
                        <div className="flex gap-1">
                          {(["text", "url", "file"] as const).map((st) => (
                            <button
                              key={st}
                              type="button"
                              onClick={() => setDocSourceType(st)}
                              className={`rounded-lg px-2 py-1 text-xs ${
                                docSourceType === st
                                  ? "bg-foreground/15 text-foreground"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {t(`chat.knowledgeBaseDocType${st.charAt(0).toUpperCase() + st.slice(1)}`)}
                            </button>
                          ))}
                        </div>
                        {docSourceType === "url" ? (
                          <input
                            type="text"
                            placeholder={t("chat.knowledgeBaseDocUrl")}
                            value={docUrl}
                            onChange={(e) => setDocUrl(e.target.value)}
                            className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
                          />
                        ) : docSourceType === "file" ? (
                          <input
                            type="file"
                            accept=".pdf,.txt,.md,.json,.csv,.xml,.yml,.yaml,.ts,.js,.py,text/*,application/pdf"
                            onChange={(e) => setDocFile(e.target.files?.[0] ?? null)}
                            className="w-full text-sm"
                          />
                        ) : (
                          <textarea
                            placeholder={t("chat.knowledgeBaseDocContent")}
                            value={docContent}
                            onChange={(e) => setDocContent(e.target.value)}
                            rows={4}
                            className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
                          />
                        )}
                        <div className="flex gap-2">
                          <MotionButton
                            type="button"
                            onClick={() => void handleIngest()}
                            disabled={ingesting}
                            className="rounded-lg bg-primary px-3 py-1 text-xs text-primary-foreground"
                          >
                            {ingesting ? t("chat.knowledgeBaseIngesting") : t("chat.knowledgeBaseIngest")}
                          </MotionButton>
                          <button
                            type="button"
                            onClick={() => setDocOpen(false)}
                            className="rounded-lg px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                          >
                            {t("common.close")}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Create KB form */}
        {!createOpen ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="text-sm text-primary hover:underline"
          >
            + {t("chat.knowledgeBaseCreate")}
          </button>
        ) : (
          <div className="space-y-2 rounded-lg bg-muted/30 p-3">
            <input
              type="text"
              placeholder={t("chat.knowledgeBaseName")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
            />
            <input
              type="text"
              placeholder={t("chat.knowledgeBaseDescription")}
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-2 py-1 text-sm"
            />
            <div className="flex gap-2">
              <MotionButton
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating}
                className="rounded-lg bg-primary px-3 py-1 text-xs text-primary-foreground"
              >
                {creating ? t("common.saving") : t("common.save")}
              </MotionButton>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="rounded-lg px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        )}
      </div>
    </AnimateModal>
  );
}
