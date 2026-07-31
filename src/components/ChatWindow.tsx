"use client";

import { memo, useEffect, useRef, useState, useCallback } from "react";
import { useChat, type ChatMessage, type DualTrace, type HyperTrace, type CouncilTrace, type InjectedSkillInfo } from "@/hooks/useChat";
import { Markdown } from "@/components/Markdown";
import { ThreadSettings } from "@/components/ThreadSettings";
import { AttachmentBar } from "@/components/AttachmentBar";
import { McpPanel } from "@/components/McpPanel";
import { KnowledgeBaseModal } from "@/components/KnowledgeBaseModal";
import { useI18n } from "@/components/I18nProvider";
import { clientFetch } from "@/lib/clientFetch";
import { PROVIDER_LABEL } from "@/lib/connections/provider-map";
import { MotionButton, Accordion } from "@/components/ui/motion";
import { AnimatePresence, motion } from "motion/react";

const SEND_MODE_STORAGE_KEY = "minerva-send-mode";
const LEGACY_SEND_MODE_STORAGE_KEY = "umanschat-send-mode";
type SendMode = "enter" | "ctrl-enter";


export const ChatWindow = memo(function ChatWindow({
  threadId,
  onCreateThread,
  onConversationEnded,
  onOpenHelp,
}: {
  threadId: string | null;
  onCreateThread?: () => Promise<string | null>;
  onConversationEnded?: () => void;
  onOpenHelp?: (topic: string | null) => void;
}) {
  const { messages, thread, isStreaming, isLoading, error, sources, send, stop, updateThread, regenerate, editMessage, switchBranch, getSiblingInfo, pendingAttachments, uploadAttachment, removeAttachment, rapid, setRapid, timeRange, setTimeRange } = useChat(threadId);
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Suppress duplicate smooth-scroll triggers (consecutive deltas accumulate and cause janky scrolling)
  const scrollAnimRef = useRef<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [connOpen, setConnOpen] = useState(false);
  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  const [kbOpen, setKbOpen] = useState(false);
  const [activeKbIds, setActiveKbIds] = useState<string[]>([]);
  const [kbModalOpen, setKbModalOpen] = useState(false);
  const [connectionsList, setConnectionsList] = useState<{ id: string; provider: string; workspaceName: string | null }[]>([]);
  const [sendMode, setSendMode] = useState<SendMode>("ctrl-enter");

  // Restore send mode from localStorage after mount (hydration-safe, same pattern as I18nProvider)
  useEffect(() => {
    try {
      const stored =
        localStorage.getItem(SEND_MODE_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_SEND_MODE_STORAGE_KEY);
      if (stored === "enter" || stored === "ctrl-enter") {
        setSendMode(stored);
        localStorage.setItem(SEND_MODE_STORAGE_KEY, stored);
      }
    } catch { /* localStorage unavailable */ }
  }, []);

  const toggleSendMode = useCallback(() => {
    setSendMode((prev) => {
      const next = prev === "enter" ? "ctrl-enter" : "enter";
      try { localStorage.setItem(SEND_MODE_STORAGE_KEY, next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const menuRef = useRef<HTMLDivElement>(null);

  // Sync mcpServerIds / connectionIds / activeKbIds on thread switch (rapid is preserved until user interaction)
  useEffect(() => {
    setMcpServerIds(thread?.mcpServerIds ?? []);
    setConnectionIds(thread?.connectionIds ?? []);
    setActiveKbIds(thread?.activeKbIds ?? []);
  }, [thread?.id, thread?.mcpServerIds, thread?.connectionIds, thread?.activeKbIds]);

  const fetchConnections = useCallback(async () => {
    const res = await clientFetch("/api/connections");
    if (res.ok) setConnectionsList(await res.json());
  }, []);

  const handleConnectionChange = useCallback(
    (ids: string[]) => {
      setConnectionIds(ids);
      void updateThread({ connectionIds: ids });
    },
    [updateThread],
  );

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setMcpOpen(false);
        setConnOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // Fetch connection list when menu opens/closes
  useEffect(() => {
    if (menuOpen) void fetchConnections();
  }, [menuOpen, fetchConnections]);

  const handleMcpChange = useCallback(
    (ids: string[]) => {
      setMcpServerIds(ids);
      void updateThread({ mcpServerIds: ids });
    },
    [updateThread],
  );
  const handleKbChange = useCallback(
    (ids: string[]) => {
      setActiveKbIds(ids);
      void updateThread({ activeKbIds: ids });
    },
    [updateThread],
  );
  const pendingRef = useRef<string | null>(null);

  // Process OAuth callback redirect parameters
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connection_success")) {
      params.delete("connection_success");
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("connection_error")) {
      params.delete("connection_error");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // Auto-scroll: only smooth-scroll when the user is near the bottom.
  // Do not jump while scrolling up (to avoid disrupting the user's reading).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distFromBottom < 150;
    if (!nearBottom) return;
    // Do not fire a new smooth scroll while one is in progress (suppress duplicates to prevent jank).
    if (scrollAnimRef.current !== null) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    scrollAnimRef.current = window.setTimeout(() => {
      scrollAnimRef.current = null;
    }, 400);
    return () => {
      if (scrollAnimRef.current) {
        clearTimeout(scrollAnimRef.current);
        scrollAnimRef.current = null;
      }
    };
  }, [messages]);

  // Auto-resize input height
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files).slice(0, 10)) {
      await uploadAttachment(file);
    }
    // Reset input to allow re-selecting the same file
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function submit() {
    const trimmed = input.trim();
    if (!trimmed || isStreaming || isCreating || pendingRef.current !== null) return;

    const attachmentIds = pendingAttachments.map((a) => a.id);

    if (!threadId) {
      if (!onCreateThread) return;
      setIsCreating(true);
      pendingRef.current = trimmed;
      setInput("");
      try {
        const newId = await onCreateThread();
        if (!newId) {
          pendingRef.current = null;
          setInput(trimmed);
        }
      } catch {
        pendingRef.current = null;
        setInput(trimmed);
      } finally {
        setIsCreating(false);
      }
      return;
    }

    void send(trimmed, { attachmentIds }).then(() => {
      onConversationEnded?.();
    });
    setInput("");
    // Clear pending attachments after sending
    for (const att of pendingAttachments) removeAttachment(att.id);
  }

  // Auto-send pending input once new thread creation completes and threadId switches.
  // Must wait until thread loading (isLoading) completes and thread resolves before sending,
  // to avoid a race where the load effect's setMessages([]) overwrites the optimistic message.
  useEffect(() => {
    if (!threadId || pendingRef.current === null || isLoading || !thread) return;
    const content = pendingRef.current;
    pendingRef.current = null;
    void send(content, {}).then(() => onConversationEnded?.());
  }, [threadId, isLoading, thread, send, onConversationEnded]);

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (sendMode === "enter") {
      // Enter送信モード: Enter=送信、Shift+Enter=改行（従来）
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    } else {
      // Ctrl+Enter送信モード: Ctrl/Cmd+Enter=送信、Enter=改行
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" role="region" aria-label={t("chat.regionChat")}>
      {thread && (
        <ThreadSettings thread={thread} onUpdate={updateThread} />
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-6" aria-live="polite" aria-label={t("chat.messageList")}>
        <div className="mx-auto flex max-w-3xl flex-col gap-3 sm:gap-4">
          {isLoading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
          {messages.length === 0 && !isLoading && (
            threadId ? <EmptyState /> : <NoThreadState />
          )}
          {messages.map((m, i) => {
            const isLastAssistant =
              i === messages.length - 1 && m.role === "assistant";
            return (
              <MessageBubble
                key={m.id}
                m={m}
                streaming={isStreaming}
                isLast={i === messages.length - 1}
                sources={isLastAssistant ? sources : []}
                onRegenerate={regenerate}
                onEdit={editMessage}
                onSwitchBranch={switchBranch}
                getSiblingInfo={getSiblingInfo}
              />
            );
          })}
          {error && (
            <motion.p
              className="text-sm text-red-500"
              initial={{ x: -8 }}
              animate={{ x: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            >
              {t("common.errorPrefix", { error })}
            </motion.p>
          )}
        </div>
      </div>

      <div className="bg-background px-3 py-3 border-t border-border sm:px-4 sm:py-4" role="region" aria-label={t("chat.messageInput")}>
        {pendingAttachments.length > 0 && (
          <div className="mx-auto mb-2 max-w-3xl">
            <AttachmentBar attachments={pendingAttachments} onRemove={removeAttachment} />
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-end">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf,text/*,.md,.txt"
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="flex items-center gap-2 sm:contents">
          <div ref={menuRef} className="relative">
            <MotionButton
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={isCreating}
              className="flex h-10 w-10 items-center justify-center rounded-2xl bg-muted text-sm transition-all duration-200 hover:bg-muted/80 disabled:opacity-40"
              aria-label={t("chat.inputMenu")}
              aria-expanded={menuOpen}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.9 }}
            >
              <span className={`transition-transform duration-200 ${menuOpen ? "rotate-45" : ""}`}>＋</span>
            </MotionButton>
            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 8 }}
                  transition={{ duration: 0.15 }}
                  className="absolute bottom-full left-0 z-50 mb-2 w-72 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-border bg-background p-1 shadow-lg"
                >
                  {/* File attachment */}
                  <button
                    type="button"
                    onClick={() => {
                      fileInputRef.current?.click();
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-muted"
                  >
                    <span>📎</span>
                    <span>{t("chat.inputMenuAttach")}</span>
                  </button>
                  {/* MCP servers */}
                  <button
                    type="button"
                    onClick={() => setMcpOpen((v) => !v)}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-muted"
                  >
                    <span>🔌</span>
                    <span className="flex-1 text-left">{t("chat.inputMenuMcp")}</span>
                    {mcpServerIds.length > 0 && (
                      <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium">
                        {mcpServerIds.length}
                      </span>
                    )}
                    <span className={`text-xs transition-transform duration-200 ${mcpOpen ? "rotate-90" : ""}`}>▶</span>
                  </button>
                  {/* MCP panel (when expanded) */}
                  <AnimatePresence>
                    {mcpOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        style={{ overflow: "hidden" }}
                      >
                        <div className="border-t border-border/50 px-1 py-1">
                          <McpPanel
                            selectedIds={mcpServerIds}
                            onChange={handleMcpChange}
                          />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {/* Connections */}
                  <button
                    type="button"
                    onClick={() => setConnOpen((v) => !v)}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-muted"
                  >
                    <span>🔗</span>
                    <span className="flex-1 text-left">{t("chat.inputMenuConnections")}</span>
                    {connectionIds.length > 0 && (
                      <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium">
                        {connectionIds.length}
                      </span>
                    )}
                    <span className={`text-xs transition-transform duration-200 ${connOpen ? "rotate-90" : ""}`}>▶</span>
                  </button>
                  {/* Connection panel (when expanded) */}
                  <AnimatePresence>
                    {connOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        style={{ overflow: "hidden" }}
                      >
                        <div className="border-t border-border/50 px-1 py-1">
                          {onOpenHelp && (
                            <button
                              type="button"
                              onClick={() => onOpenHelp("connections.notion")}
                              className="px-1 py-1 text-left text-[10px] text-muted-foreground underline hover:text-foreground"
                            >
                              {t("help.connectionsWhatIs")}
                            </button>
                          )}
                          {connectionsList.map((conn) => (
                            <label key={conn.id} className="flex items-center gap-2 rounded-lg px-1 py-1 text-xs hover:bg-muted/50">
                              <input
                                type="checkbox"
                                checked={connectionIds.includes(conn.id)}
                                onChange={(e) => {
                                  handleConnectionChange(
                                    e.target.checked
                                      ? [...connectionIds, conn.id]
                                      : connectionIds.filter((id) => id !== conn.id),
                                  );
                                }}
                              />
                              <span>{conn.workspaceName ?? PROVIDER_LABEL[conn.provider as keyof typeof PROVIDER_LABEL] ?? conn.provider}</span>
                              <span className="text-muted-foreground">({conn.provider})</span>
                            </label>
                          ))}
                          {connectionsList.length === 0 && (
                            <p className="px-1 py-2 text-xs text-muted-foreground">{t("settings.noConnections")}</p>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {/* Knowledge bases */}
                  <button
                    type="button"
                    onClick={() => setKbOpen((v) => !v)}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-muted"
                  >
                    <span>📚</span>
                    <span className="flex-1 text-left">{t("chat.inputMenuKnowledgeBases")}</span>
                    {activeKbIds.length > 0 && (
                      <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium">
                        {activeKbIds.length}
                      </span>
                    )}
                    <span className={`text-xs transition-transform duration-200 ${kbOpen ? "rotate-90" : ""}`}>▶</span>
                  </button>
                  <AnimatePresence>
                    {kbOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        style={{ overflow: "hidden" }}
                      >
                        <div className="border-t border-border/50 px-1 py-1">
                          <button
                            type="button"
                            onClick={() => setKbModalOpen(true)}
                            className="w-full rounded-lg px-1 py-1 text-left text-xs text-primary hover:underline"
                          >
                            {t("chat.knowledgeBaseManage")}
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <MotionButton
            type="button"
            onClick={toggleSendMode}
            className={`flex h-10 items-center justify-center rounded-2xl px-2 text-xs font-medium transition-all duration-200 ${
              sendMode === "enter"
                ? "bg-foreground/15 text-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
            aria-label={sendMode === "enter" ? t("chat.sendModeEnter") : t("chat.sendModeCtrlEnter")}
            aria-pressed={sendMode === "enter"}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.9 }}
          >
            {sendMode === "enter" ? "↵" : "⌃↵"}
          </MotionButton>
          <MotionButton
            type="button"
            onClick={() => setRapid((v) => !v)}
            className={`flex h-10 w-10 items-center justify-center rounded-2xl text-sm transition-all duration-200 disabled:opacity-40 ${
              rapid ? "bg-foreground/15 text-foreground" : "bg-muted hover:bg-muted/80"
            }`}
            aria-label={rapid ? t("chat.rapidModeActive") : t("chat.rapidMode")}
            aria-pressed={rapid}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.9 }}
          >
            ⚡
          </MotionButton>
          <select
            value={timeRange ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setTimeRange(v === "" ? null : (v as "day" | "week" | "month" | "year"));
            }}
            className="h-10 rounded-2xl bg-muted px-2 text-sm outline-none transition-all duration-200 hover:bg-muted/80 disabled:opacity-40"
            aria-label={t("chat.searchTimeRange")}
            disabled={isCreating}
          >
            <option value="">{t("chat.timeRangeNone")}</option>
            <option value="day">{t("chat.timeRangeDay")}</option>
            <option value="week">{t("chat.timeRangeWeek")}</option>
            <option value="month">{t("chat.timeRangeMonth")}</option>
            <option value="year">{t("chat.timeRangeYear")}</option>
          </select>
          </div>
          <div className="flex items-end gap-2 sm:contents">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            disabled={isCreating}
            placeholder={sendMode === "enter" ? t("chat.placeholderEnter") : t("chat.placeholderCtrlEnter")}
            aria-label={t("chat.messageInput")}
            className="min-h-[40px] flex-1 resize-none rounded-2xl bg-muted px-4 py-3 text-sm outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20 disabled:opacity-50"
          />
          <AnimatePresence mode="wait" initial={false}>
            {isStreaming ? (
              <motion.button
                key="stop"
                type="button"
                onClick={stop}
                className="h-10 rounded-2xl bg-muted px-3 text-sm transition-all duration-200 hover:bg-muted/80"
                aria-label={t("chat.stopGeneration")}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.15 }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.9 }}
              >
                {t("chat.stop")}
              </motion.button>
            ) : (
              <motion.button
                key="send"
                type="button"
                onClick={submit}
                disabled={!input.trim() || isCreating}
                aria-label={t("chat.sendMessage")}
                className="rounded-2xl bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-all duration-200 hover:opacity-90 disabled:opacity-40"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.15 }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.9 }}
              >
                {isCreating ? t("chat.creating") : t("chat.send")}
              </motion.button>
            )}
          </AnimatePresence>
          </div>
        </div>
      </div>
      <KnowledgeBaseModal
        open={kbModalOpen}
        onClose={() => setKbModalOpen(false)}
        selectedKbIds={activeKbIds}
        onChange={handleKbChange}
      />
    </div>
  );
});

function EmptyState() {
  const { t } = useI18n();
  return (
    <div className="mt-24 flex flex-col items-center gap-3 text-center text-muted-foreground" role="status">
      <p className="text-lg font-semibold tracking-tight text-foreground">MinervaAIWorkspace</p>
      <p className="text-sm">{t("chat.emptyThread")}</p>
    </div>
  );
}

function NoThreadState() {
  const { t } = useI18n();
  return (
    <div className="mt-24 flex flex-col items-center gap-3 text-center text-muted-foreground" role="status">
      <p className="text-lg font-semibold tracking-tight text-foreground">MinervaAIWorkspace</p>
      <p className="text-sm">{t("chat.emptyNoThread")}</p>
    </div>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  const { t } = useI18n();
  return (
    <Accordion
      className="mb-2 rounded-xl bg-muted/50 px-3 py-2"
      summaryClassName="cursor-pointer select-none text-xs text-muted-foreground"
      summary={t("chat.thinking")}
    >
      <div className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground" role="region" aria-label={t("chat.thinkingContent")}>{content}</div>
    </Accordion>
  );
}

function splitThinking(content: string): { thinking: string; answer: string } {
  const parts: string[] = [];
  // Extract closed <thinking>...</thinking> and <think>...</think> blocks.
  // The backreference \1 ensures opening and closing tags match.
  let remaining = content.replace(
    /<(thinking|think)>([\s\S]*?)<\/\1>/g,
    (_, _tag: string, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) parts.push(trimmed);
      return "";
    },
  );
  // Handle unclosed opening tag (streaming: <think> arrived but </think> hasn't).
  // Text before the tag becomes answer; everything after is buffered as thinking.
  remaining = remaining.replace(
    /([\s\S]*?)<(thinking|think)>([\s\S]*)/,
    (_, before: string, _tag: string, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) parts.push(trimmed);
      return before;
    },
  );
  return { thinking: parts.join("\n---\n"), answer: remaining.trim() };
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}

/**
 * Skill chips: show injected skills with 👍/👎 feedback buttons.
 * Data source: message.metadata.injectedSkills (SSE live + DB persistent).
 * Feedback is sent to POST /api/skill-usage/[id]/feedback.
 */
function SkillChips({ skills }: { skills: InjectedSkillInfo[] }) {
  const { t } = useI18n();
  const [submitted, setSubmitted] = useState<Record<string, "helpful" | "not_helpful">>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});

  if (skills.length === 0) return null;

  const handleFeedback = async (usageEventId: string, outcome: "helpful" | "not_helpful") => {
    if (submitting[usageEventId]) return;
    setSubmitting((prev) => ({ ...prev, [usageEventId]: true }));
    try {
      const res = await clientFetch(`/api/skill-usage/${usageEventId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      if (res.ok) {
        setSubmitted((prev) => ({ ...prev, [usageEventId]: outcome }));
      }
    } catch {
      // Silently fail — feedback is best-effort
    } finally {
      setSubmitting((prev) => ({ ...prev, [usageEventId]: false }));
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5 mt-1" aria-label={t("skills.skillsInjected")}>
      {skills.map((skill) => {
        const voted = submitted[skill.usageEventId];
        const isSubmitting = submitting[skill.usageEventId];
        return (
          <div
            key={skill.usageEventId}
            className="inline-flex items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            <span className="font-medium">{skill.name}</span>
            {!voted ? (
              <>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => handleFeedback(skill.usageEventId, "helpful")}
                  className="rounded-full px-1 hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1"
                  aria-label={t("skills.feedbackHelpful")}
                >
                  {t("skills.feedbackHelpful")}
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => handleFeedback(skill.usageEventId, "not_helpful")}
                  className="rounded-full px-1 hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1"
                  aria-label={t("skills.feedbackNotHelpful")}
                >
                  {t("skills.feedbackNotHelpful")}
                </button>
              </>
            ) : (
              <span className="text-[10px]">{t("skills.feedbackThanks")}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

type MessageBubbleProps = {
  m: ChatMessage;
  streaming: boolean;
  isLast: boolean;
  sources: { url: string; title: string; snippet: string }[];
  onRegenerate: (userMessageId: string) => Promise<void>;
  onEdit: (userMessageId: string, newContent: string) => Promise<void>;
  onSwitchBranch: (messageId: string) => void;
  getSiblingInfo: (messageId: string) => { siblings: string[]; currentIndex: number };
};

function MessageBubble({
  m,
  streaming,
  isLast,
  sources,
  onRegenerate,
  onEdit,
  onSwitchBranch,
  getSiblingInfo,
}: MessageBubbleProps) {
  const { t } = useI18n();
  const isAssistant = m.role === "assistant";
  // Show spinner/progress label while thinking is received but no answer is generated yet.
  // Show spinner only when answer is empty and there is no thinking; when thinking exists,
  // show a progress label alongside the ThinkingBlock above.
  const isStreamingThis = streaming && isAssistant && m.content === "";
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(m.content);
  // Sync editText when m.content changes (e.g. streaming), unless editing.
  // Preserve user input during editing; do not overwrite with stale content.
  useEffect(() => {
    if (!editing) setEditText(m.content);
  }, [m.content, editing]);

  const { siblings, currentIndex } = getSiblingInfo(m.id);
  const hasBranches = siblings.length > 1;

  // Regenerate assistant message: requires the parent user message id
  const handleRegenerate = () => {
    if (m.parentId) void onRegenerate(m.parentId);
  };

  const handleEditSubmit = () => {
 const trimmed = editText.trim();
    if (trimmed && trimmed !== m.content) {
      void onEdit(m.id, trimmed);
    }
    setEditing(false);
  };

  if (isAssistant) {
    const inline = !m.thinking ? splitThinking(m.content) : null;
    const thinking = m.thinking ?? inline?.thinking ?? "";
    const answer = inline ? inline.answer : m.content;

    return (
      <div className="flex flex-col items-start gap-1 animate-[msg-in_0.3s_ease-out]" role="article">
        {thinking && <ThinkingBlock content={thinking} />}
        <div className="w-full px-0 py-1 text-foreground">
          {answer ? (
            <Markdown content={answer} />
          ) : null}
          {m.metadata?.dualTrace && (
            <DualTraceDetails trace={m.metadata.dualTrace} />
          )}
          {m.metadata?.hyperTrace && (
            <HyperTraceDetails trace={m.metadata.hyperTrace} />
          )}
          {m.metadata?.councilTrace && (
            <CouncilTraceDetails trace={m.metadata.councilTrace} streaming={isStreamingThis} />
          )}
          {/* Show spinner + progress label while no answer is generated. Also shown while thinking is received. */}
          {isStreamingThis && !m.thinking ? (
            <span aria-label={t("chat.waitingResponse")} className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className="loading-spinner inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
              {m.statusLabel ?? t("chat.waitingResponseAria")}
            </span>
          ) : null}
          {/* While thinking is received, show only the progress label without spinner (coexists with ThinkingBlock). */}
          {isStreamingThis && m.thinking && m.statusLabel ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="loading-spinner inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
              {m.statusLabel}
            </span>
          ) : null}
          {streaming && isLast && answer && (
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-[blink_1s_ease-in-out_infinite] bg-foreground align-middle" aria-hidden="true" />
          )}
        </div>
        {hasBranches && (
          <BranchNav
            currentIndex={currentIndex}
            total={siblings.length}
            onPrev={() => onSwitchBranch(siblings[Math.max(0, currentIndex - 1)])}
            onNext={() => onSwitchBranch(siblings[Math.min(siblings.length - 1, currentIndex + 1)])}
          />
        )}
        {m.metadata?.injectedSkills && m.metadata.injectedSkills.length > 0 && (
          <SkillChips skills={m.metadata.injectedSkills} />
        )}
        {!streaming && answer && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {m.model && <span className="font-mono">{m.model}</span>}
            {m.elapsedMs != null && <span>· {formatElapsed(m.elapsedMs)}</span>}
            {isLast && (
              <button
                type="button"
                onClick={handleRegenerate}
                className="rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
                aria-label={t("chat.regenerate")}
              >
                {t("chat.regenerateLabel")}
              </button>
            )}
          </div>
        )}
        {sources.length > 0 && (
          <div className="mt-2 rounded-xl bg-muted/50 px-3 py-2" aria-label={t("chat.references")}>
            <p className="text-[10px] text-muted-foreground mb-1">{t("chat.referenceCount", { count: sources.length })}</p>
            <ul className="space-y-0.5">
              {sources.map((s, i) => (
                <li key={s.url}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-accent hover:underline"
                  >
                    {s.title || s.url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1" role="article">
      {editing ? (
        <div className="flex max-w-[90%] flex-col gap-1 sm:max-w-[85%]">
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={2}
            autoFocus
            aria-label={t("chat.editMessage")}
            className="resize-none rounded-2xl bg-muted px-3 py-2 text-sm outline-none transition-all duration-200 focus:ring-2 focus:ring-foreground/20"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleEditSubmit}
              className="rounded-xl bg-foreground px-3 py-1 text-xs text-background hover:opacity-90"
              aria-label={t("chat.submitEdit")}
            >
              {t("chat.send")}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setEditText(m.content); }}
              className="rounded-xl bg-muted px-3 py-1 text-xs hover:bg-muted/80"
              aria-label={t("chat.cancelEdit")}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex max-w-[90%] flex-col items-end gap-1 sm:max-w-[85%]">
          {m.attachments && m.attachments.length > 0 && (
            <AttachmentBar attachments={m.attachments} />
          )}
          <div className="whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground ring-1 ring-border animate-[msg-in_0.3s_ease-out]">
            {m.content}
          </div>
        </div>
      )}
      {hasBranches && !editing && (
        <BranchNav
          currentIndex={currentIndex}
          total={siblings.length}
          onPrev={() => onSwitchBranch(siblings[Math.max(0, currentIndex - 1)])}
          onNext={() => onSwitchBranch(siblings[Math.min(siblings.length - 1, currentIndex + 1)])}
        />
      )}
      {!editing && !streaming && (
        <button
          type="button"
          onClick={() => { setEditText(m.content); setEditing(true); }}
          className="rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground"
          aria-label={t("chat.editMessage")}
        >
          {t("chat.editLabel")}
        </button>
      )}
    </div>
  );
}
function DualTraceDetails({ trace }: { trace: DualTrace }) {
  const { t } = useI18n();
  return (
    <Accordion
      className="mt-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-2"
      summaryClassName="cursor-pointer select-none text-xs font-medium text-muted-foreground"
      summary={t("chat.dualDetails")}
    >
      <div className="mt-3 space-y-3">
        <p className="text-[11px] text-muted-foreground">
          {t("chat.dualFinalModel", { model: trace.finalModel })}
        </p>
        <TraceSection title={`${t("chat.dualAnswerA")} (${trace.modelA})`} content={trace.answerA} />
        <TraceSection title={`${t("chat.dualAnswerB")} (${trace.modelB})`} content={trace.answerB} />
        {trace.strategy === "cross_review" ? (
          <>
            {trace.reviewA && <TraceSection title={t("chat.dualReviewA")} content={trace.reviewA} />}
            {trace.reviewB && <TraceSection title={t("chat.dualReviewB")} content={trace.reviewB} />}
          </>
        ) : (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground">{t("chat.dualDebate")}</h4>
            {trace.debateTurns?.map((turn, index) => (
              <TraceSection
                key={`${turn.speaker}-${index}`}
                title={`Model ${turn.speaker} (${turn.model})`}
                content={turn.content}
              />
            ))}
          </div>
        )}
      </div>
    </Accordion>
  );
}

function HyperTraceDetails({ trace }: { trace: HyperTrace }) {
  const { t } = useI18n();
  return (
    <Accordion
      className="mt-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-2"
      summaryClassName="cursor-pointer select-none text-xs font-medium text-muted-foreground"
      summary={t("chat.hyperDetails")}
    >
      <div className="mt-3 space-y-3">
        <p className="text-[11px] text-muted-foreground">
          {t("chat.hyperFinalModel", { model: trace.finalModel })}
        </p>
        {trace.rounds.map((round, index) => (
          <div key={index} className="space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground">
              {t("chat.hyperRound", { round: String(index + 1) })}
            </h4>
            <p className="text-[11px] text-muted-foreground">
              {t("chat.hyperPerspective", { perspective: round.perspective })}
            </p>
            <TraceSection title={t("chat.hyperDraft")} content={round.draft} />
            <TraceSection title={t("chat.hyperCritique")} content={round.critique} />
            <TraceSection title={t("chat.hyperRevised")} content={round.revised} />
          </div>
        ))}
      </div>
    </Accordion>
  );
}

function CouncilTraceDetails({ trace, streaming = false }: { trace: CouncilTrace; streaming?: boolean }) {
  const { t } = useI18n();
  const panelMap = new Map(trace.panels.map((p) => [p.id, p]));
  return (
    <Accordion
      defaultOpen={streaming}
      className="mt-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-2"
      summaryClassName="cursor-pointer select-none text-xs font-medium text-muted-foreground"
      summary={
        <span className="flex items-center gap-2">
          {t("chat.councilDetails")}
          {streaming && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-foreground/50" aria-hidden="true" />
          )}
        </span>
      }
    >
      <div className="mt-3 space-y-3">
        <p className="text-[11px] text-muted-foreground">
          {t("chat.councilFinalModel", { model: trace.finalModel })}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {t("chat.councilRoundsCompleted", { count: String(trace.roundsCompleted) })}
          {trace.timeLimitReached && ` — ${t("chat.councilTimeLimitReached")}`}
        </p>
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground">{t("chat.councilPanels")}</h4>
          {trace.panels.map((panel) => (
            <p key={panel.id} className="text-[11px] text-muted-foreground">
              <strong>{t("chat.councilPanel", { panel: panel.id })}</strong>: {panel.persona}
            </p>
          ))}
        </div>
        <h4 className="text-xs font-semibold text-muted-foreground">{t("chat.councilInitialAnswers")}</h4>
        {trace.initialAnswers.map((ans) => {
          const panel = panelMap.get(ans.panelId);
          return (
            <TraceSection
              key={ans.panelId}
              title={`${t("chat.councilPanel", { panel: ans.panelId })} — ${panel?.persona ?? ""}`}
              content={ans.content}
            />
          );
        })}
        <h4 className="text-xs font-semibold text-muted-foreground">{t("chat.councilDiscussion")}</h4>
        {trace.discussionTurns.map((turn, idx) => {
          const panel = panelMap.get(turn.panelId);
          return (
            <TraceSection
              key={`${turn.panelId}-${turn.round}-${idx}`}
              title={`${t("chat.councilPanel", { panel: turn.panelId })} — R${turn.round} (${panel?.persona ?? ""})`}
              content={turn.content}
            />
          );
        })}
      </div>
    </Accordion>
  );
}

function TraceSection({ title, content }: { title: string; content: string }) {
  return (
    <section className="space-y-1">
      <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
      <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-2">
        <Markdown content={content || "_No content_"} />
      </div>
    </section>
  );
}

function BranchNav({
  currentIndex,
  total,
  onPrev,
  onNext,
}: {
  currentIndex: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground" role="group" aria-label={t("chat.branchPosition", { current: currentIndex + 1, total })}>
      <button type="button" onClick={onPrev} disabled={currentIndex === 0} className="rounded-lg px-2 py-0.5 transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-30" aria-label={t("chat.prevBranch")}>
        ‹
      </button>
      <span aria-current="true">{currentIndex + 1}/{total}</span>
      <button type="button" onClick={onNext} disabled={currentIndex === total - 1} className="rounded-lg px-2 py-0.5 transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-30" aria-label={t("chat.nextBranch")}>
        ›
      </button>
    </div>
  );
}
