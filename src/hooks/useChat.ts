"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceInfo } from "@/lib/scraper";
import { useI18n } from "@/components/I18nProvider";
import { clientFetch } from "@/lib/clientFetch";

export type ChatRole = "user" | "assistant" | "system";
export type DualTrace = {
  strategy: "cross_review" | "debate";
  modelA: string;
  modelB: string;
  finalModel: string;
  answerA: string;
  answerB: string;
  reviewA?: string;
  reviewB?: string;
  debateTurns?: { speaker: "A" | "B"; model: string; content: string }[];
};
export type HyperTrace = {
  rounds: {
    perspective: string;
    draft: string;
    critique: string;
    revised: string;
  }[];
  finalModel: string;
};
export type CouncilTrace = {
  panels: { id: string; persona: string; model: string }[];
  initialAnswers: { panelId: string; content: string }[];
  discussionTurns: { panelId: string; round: number; content: string }[];
  finalModel: string;
  roundsCompleted: number;
  timeLimitReached: boolean;
};
export type MessageAttachment = {
  id: string;
  messageId: string | null;
  filename: string;
  mimeType: string;
  dataUrl: string | null;
};
export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  thinking?: string;
  parentId: string | null;
  attachments?: MessageAttachment[];
  statusLabel?: string;
  model?: string;
  elapsedMs?: number;
  metadata?: {
    dualTrace?: DualTrace;
    hyperTrace?: HyperTrace;
    councilTrace?: CouncilTrace;
    model?: string;
    elapsedMs?: number;
  } | null;
};

type Thread = {
  id: string;
  title: string;
  systemPrompt: string | null;
  model: string;
  currentLeafId: string | null;
  responseMode: "single" | "dual" | "hyper" | "council";
  dualModelA: string | null;
  dualModelB: string | null;
  dualStrategy: "cross_review" | "debate";
  dualDebateRounds: number;
  hyperRounds: number;
  councilSize: number;
  councilTimeLimit: number;
  mcpServerIds: string[];
  connectionIds: string[];
  globalInstructionId: string | null;
};


type RawMessage = {
  id: string;
  parentId: string | null;
  role: ChatRole;
  content: string;
  reasoning?: string | null;
  statusLabel?: string;
  model?: string;
  elapsedMs?: number;
  metadata?: {
    dualTrace?: DualTrace;
    hyperTrace?: HyperTrace;
    councilTrace?: CouncilTrace;
    model?: string;
    elapsedMs?: number;
  } | null;
};

type RawAttachment = {
  id: string;
  messageId: string | null;
  filename: string;
  mimeType: string;
  dataUrl: string | null;
};

type SseData = {
  delta?: string;
  content?: string;
  message?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  sources?: SourceInfo[];
  phase?: string;
  label?: string;
  dualTrace?: DualTrace;
  hyperTrace?: HyperTrace;
  councilTrace?: CouncilTrace;
  councilPanels?: { id: string; persona: string; model: string }[];
  councilFinalModel?: string;
  councilPanelId?: string;
  councilContent?: string;
  councilRound?: number;
  model?: string;
  elapsedMs?: number;
};

/**
 * Single-thread streaming chat (Phase 5: branching support).
 *
 * - Fetches all messages from GET /api/threads/[id],
 *   traces the parent chain from thread.currentLeafId to build a linear list for display.
 * - send(content): generates a new user → assistant.
 * - regenerate(userMsgId): generates a new assistant under an existing user.
 * - editMessage(userMsgId, newContent): creates a sibling of the user and generates an assistant.
 * - Each message's siblings (same parentId) are kept as siblings,
 *   and the UI displays a "< 1/2 >" branch navigation.
 */
export function useChat(threadId: string | null) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [rapid, setRapid] = useState(false);
  const [timeRange, setTimeRange] = useState<"day" | "week" | "month" | "year" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Track the optimistic assistant ID currently being streamed.
  // Used by visibility-resync to detect if the server completed while backgrounded.
  const streamingAssistantIdRef = useRef<string | null>(null);
  // The real user message ID from the SSE "start" event.
  // Used to find the assistant response by parentId during polling.
  const realUserMsgIdRef = useRef<string | null>(null);
  // WakeLock handle to keep the screen on during streaming (mobile).
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  // Polling timer reference for visibility-resync.
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the user explicitly stopped the stream (vs. background-disconnect).
  const userStoppedRef = useRef(false);
  // True when handleResync aborted the fetch — distinguishes background-disconnect
  // from normal completion in streamChat's finally block.
  const resyncingRef = useRef(false);

  // Keep all messages in a byId map (all branch nodes)
  const byIdRef = useRef<Map<string, RawMessage>>(new Map());
  const attachmentsByMsgIdRef = useRef<Map<string, RawAttachment[]>>(new Map());

  // Trace the parent chain from leafId to root, building an ascending ChatMessage[].
  function buildChain(leafId: string): ChatMessage[] {
    const chain: ChatMessage[] = [];
    let currentId: string | null = leafId;
    while (currentId) {
      const msg = byIdRef.current.get(currentId);
      if (!msg) break;
      chain.unshift({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        thinking: msg.reasoning ?? undefined,
        parentId: msg.parentId,
        attachments: attachmentsByMsgIdRef.current.get(msg.id),
        statusLabel: msg.statusLabel,
        model: msg.model ?? msg.metadata?.model,
        elapsedMs: msg.elapsedMs ?? msg.metadata?.elapsedMs,
        metadata: msg.metadata,
      });
      currentId = msg.parentId;
    }
    return chain;
  }

  // Load on thread switch.
  useEffect(() => {
    if (!threadId) {
      byIdRef.current = new Map();
      attachmentsByMsgIdRef.current = new Map();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessages([]);
      setThread(null);
      setError(null);
      setSources([]);
      return;
    }
    let cancelled = false;

    void (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await clientFetch(`/api/threads/${threadId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          thread: Thread;
          messages: RawMessage[];
          attachments?: RawAttachment[];
        };
        if (cancelled) return;

        // Build byId map
        const byId = new Map<string, RawMessage>();
        for (const m of data.messages) {
          byId.set(m.id, m);
        }
        byIdRef.current = byId;

        // Build attachments map
        const attMap = new Map<string, RawAttachment[]>();
        if (data.attachments) {
          for (const att of data.attachments) {
            if (att.messageId) {
              const existing = attMap.get(att.messageId) ?? [];
              existing.push(att);
              attMap.set(att.messageId, existing);
            }
          }
        }
        attachmentsByMsgIdRef.current = attMap;

        setThread(data.thread);
        const leafId = data.thread.currentLeafId ?? data.messages[data.messages.length - 1]?.id ?? null;
        setMessages(leafId ? buildChain(leafId) : []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t("chat.loadError"));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // Abort in-flight stream on thread switch,
      // preventing the old thread's SSE from overwriting the new thread's state.
      abortRef.current?.abort();
    };
  }, [threadId, t]);
  const stop = useCallback(() => {
    userStoppedRef.current = true;
    resyncingRef.current = false;
    abortRef.current?.abort();
    // Clear any pending visibility-resync poll immediately.
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => { /* non-fatal */ });
      wakeLockRef.current = null;
    }
    setIsStreaming(false);
    streamingAssistantIdRef.current = null;
  }, []);

  const clear = useCallback(() => {
    if (isStreaming) abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setSources([]);
  }, [isStreaming]);

  // Common function to process SSE streaming
  async function streamChat(
    body: Record<string, unknown>,
    optimisticUser: ChatMessage | null,
    assistantId: string,
  ) {
    if (optimisticUser) {
      // Add optimistic user to byId
      byIdRef.current.set(optimisticUser.id, {
        id: optimisticUser.id,
        parentId: optimisticUser.parentId,
        role: "user",
        content: optimisticUser.content,
      });
    }
    byIdRef.current.set(assistantId, {
      id: assistantId,
      parentId: optimisticUser?.id ?? (body.parentMessageId as string | undefined) ?? null,
      role: "assistant",
      content: "",
    });

    // Update current leafId and rebuild chain
    if (thread) {
      const newThread = { ...thread, currentLeafId: assistantId };
      setThread(newThread);
    }
    setMessages(buildChain(assistantId));
    setError(null);
    setSources([]);
    setIsStreaming(true);
    streamingAssistantIdRef.current = assistantId;
    realUserMsgIdRef.current = null;
    userStoppedRef.current = false;

    const ac = new AbortController();
    abortRef.current = ac;

    // Request a screen wake lock to prevent the screen from turning off
    // during streaming on mobile. Non-blocking: if unsupported, silently skip.
    if (typeof navigator !== "undefined" && "wakeLock" in navigator) {
      navigator.wakeLock.request("screen").then(
        (lock: { release: () => Promise<void> }) => { wakeLockRef.current = lock; },
        () => { /* wakeLock denied or unsupported — non-fatal */ },
      );
    }

    try {
      const res = await clientFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = parseSse(raw);
          if (!event) continue;

          if (event.event === "start" && event.data?.userMessageId) {
            const realId = event.data.userMessageId;
            realUserMsgIdRef.current = realId;
            if (optimisticUser) {
              const oldMsg = byIdRef.current.get(optimisticUser.id);
              if (oldMsg) {
                byIdRef.current.delete(optimisticUser.id);
                byIdRef.current.set(realId, { ...oldMsg, id: realId });
              }
              // Update assistant's parent too
              const asstMsg = byIdRef.current.get(assistantId);
              if (asstMsg) {
                byIdRef.current.set(assistantId, { ...asstMsg, parentId: realId });
              }
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "thinking" && event.data?.delta) {
            const existing = byIdRef.current.get(assistantId);
            if (existing) {
              const currentThinking = existing.reasoning ?? "";
              byIdRef.current.set(assistantId, {
                ...existing,
                reasoning: currentThinking + event.data.delta,
              });
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "status" && event.data?.label) {
            const existing = byIdRef.current.get(assistantId);
            if (existing) {
              byIdRef.current.set(assistantId, {
                ...existing,
                statusLabel: event.data.label,
              });
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "dual_trace" && event.data?.dualTrace) {
            const existing = byIdRef.current.get(assistantId);
            if (existing) {
              byIdRef.current.set(assistantId, {
                ...existing,
                metadata: { ...(existing.metadata ?? {}), dualTrace: event.data.dualTrace },
              });
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "hyper_trace" && event.data?.hyperTrace) {
            const existing = byIdRef.current.get(assistantId);
            if (existing) {
              byIdRef.current.set(assistantId, {
                ...existing,
                metadata: { ...(existing.metadata ?? {}), hyperTrace: event.data.hyperTrace },
              });
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "council_trace" && event.data?.councilTrace) {
            const existing = byIdRef.current.get(assistantId);
            if (existing) {
              byIdRef.current.set(assistantId, {
                ...existing,
                metadata: { ...(existing.metadata ?? {}), councilTrace: event.data.councilTrace },
              });
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "council_panels" && event.data?.councilPanels) {
            const existing = byIdRef.current.get(assistantId);
            if (existing) {
              byIdRef.current.set(assistantId, {
                ...existing,
                metadata: {
                  ...(existing.metadata ?? {}),
                  councilTrace: {
                    panels: event.data.councilPanels,
                    initialAnswers: [],
                    discussionTurns: [],
                    finalModel: event.data.councilFinalModel ?? "",
                    roundsCompleted: 0,
                    timeLimitReached: false,
                  },
                },
              });
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "council_initial" && event.data?.councilPanelId) {
            const existing = byIdRef.current.get(assistantId);
            if (existing?.metadata?.councilTrace) {
              byIdRef.current.set(assistantId, {
                ...existing,
                metadata: {
                  ...existing.metadata,
                  councilTrace: {
                    ...existing.metadata.councilTrace,
                    initialAnswers: [
                      ...existing.metadata.councilTrace.initialAnswers,
                      { panelId: event.data.councilPanelId, content: event.data.councilContent ?? "" },
                    ],
                  },
                },
              });
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "council_turn" && event.data?.councilPanelId) {
            const existing = byIdRef.current.get(assistantId);
            if (existing?.metadata?.councilTrace) {
              byIdRef.current.set(assistantId, {
                ...existing,
                metadata: {
                  ...existing.metadata,
                  councilTrace: {
                    ...existing.metadata.councilTrace,
                    discussionTurns: [
                      ...existing.metadata.councilTrace.discussionTurns,
                      { panelId: event.data.councilPanelId, round: event.data.councilRound ?? 1, content: event.data.councilContent ?? "" },
                    ],
                  },
                },
              });
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "delta" && event.data?.delta) {
            const existing = byIdRef.current.get(assistantId);
            if (existing) {
              byIdRef.current.set(assistantId, {
                ...existing,
                content: existing.content + event.data.delta,
                statusLabel: undefined,
              });
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "replace_content" && typeof event.data?.content === "string") {
            const existing = byIdRef.current.get(assistantId);
            if (existing) {
              byIdRef.current.set(assistantId, {
                ...existing,
                content: event.data.content,
                statusLabel: undefined,
              });
              setMessages(buildChain(assistantId));
            }
          } else if (event.event === "sources" && event.data?.sources) {
            setSources(event.data.sources);
          } else if (event.event === "done" && event.data?.assistantMessageId) {
            const realId = event.data.assistantMessageId;
            const oldMsg = byIdRef.current.get(assistantId);
            if (oldMsg) {
              byIdRef.current.delete(assistantId);
              byIdRef.current.set(realId, {
                ...oldMsg,
                id: realId,
                model: event.data.model,
                elapsedMs: event.data.elapsedMs,
              });
            }
            // Update thread's currentLeafId
            if (thread) {
              setThread({ ...thread, currentLeafId: realId });
            }
            setMessages(buildChain(realId));
          } else if (event.event === "error") {
            setError(event.data?.message ?? t("chat.streamError"));
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // Stopped: keep partial response as-is
      } else {
        setError(err instanceof Error ? err.message : t("chat.fetchError"));
      }
    } finally {
      // If handleResync triggered the abort (background-disconnect), skip
      // streaming state cleanup — the resync poll owns it now and will
      // call setIsStreaming(false) / clear refs / release wakeLock when
      // the server completes or the poll times out.
      if (resyncingRef.current) {
        abortRef.current = null;
        return;
      }

      setIsStreaming(false);
      abortRef.current = null;
      streamingAssistantIdRef.current = null;

      // Release the screen wake lock if we acquired one.
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => { /* non-fatal */ });
        wakeLockRef.current = null;
      }
      // pollRef cleanup is handled by the visibility-resync effect's own
      // cleanup function — NOT here. Clearing it here would race with
      // handleResync's abort() → finally → clear poll sequence.
    }
  }

  /**
   * Mobile background resync: when the page returns to the foreground during
   * streaming, the SSE fetch may have been killed by the OS. Abort the stale
   * fetch, re-fetch the thread, and poll until the assistant message appears.
   *
   * Completion detection: look for a new assistant message whose parentId
   * matches the real user message ID (from the SSE "start" event), or any
   * assistant message in the server data that isn't in our local byId map.
   * We do NOT use currentLeafId — it's updated to the user message early
   * in some flows and would give false "completed" signals.
   */
  useEffect(() => {
    if (!threadId) return;

    const handleResync = () => {
      // Only resync if we're actively streaming, user didn't stop, and we're
      // not already polling from a prior resync (iOS fires rapidly on tab switch).
      if (!streamingAssistantIdRef.current || userStoppedRef.current || resyncingRef.current) return;

      // Capture refs BEFORE aborting — abort triggers streamChat's finally block
      // which clears streamingAssistantIdRef.current.
      const optimisticAssistantId = streamingAssistantIdRef.current;
      const knownUserMsgId = realUserMsgIdRef.current;

      // Collect message IDs we already know about (optimistic IDs included).
      const knownIds = new Set(byIdRef.current.keys());

      // Set resyncing flag BEFORE abort — the streamChat finally block checks
      // this to skip setIsStreaming(false) and ref cleanup (poll owns those now).
      resyncingRef.current = true;
      // Abort the stale fetch — the OS likely killed it when backgrounding.
      // The server continues generating regardless (send() is error-safe).
      abortRef.current?.abort();

      const pollOnce = async (): Promise<boolean> => {
        try {
          const res = await clientFetch(`/api/threads/${threadId}`);
          if (!res.ok) return false;
          const data = (await res.json()) as {
            thread: Thread;
            messages: RawMessage[];
            attachments?: RawAttachment[];
          };

          // Look for a new assistant message we haven't seen before.
          const newAssistant = data.messages.find(
            (m) => m.role === "assistant" && !knownIds.has(m.id),
          );

          // Also check: if we know the real user message ID, look for an
          // assistant message whose parentId matches it.
          const assistantByParentId = knownUserMsgId
            ? data.messages.find(
                (m) => m.role === "assistant" && m.parentId === knownUserMsgId,
              )
            : null;

          const found = newAssistant ?? assistantByParentId;
          if (!found) return false;

          // Server completed — rebuild local state from server data.
          const byId = new Map<string, RawMessage>();
          for (const m of data.messages) byId.set(m.id, m);

          // Preserve optimistic user message if server hasn't created it yet
          // (shouldn't happen since prepareTurn inserts it, but defensive).
          const optimisticUser = byIdRef.current.get(optimisticAssistantId);
          // Remove the optimistic assistant placeholder.
          byId.delete(optimisticAssistantId);

          byIdRef.current = byId;

          // Rebuild attachments map.
          const attMap = new Map<string, RawAttachment[]>();
          if (data.attachments) {
            for (const att of data.attachments) {
              if (att.messageId) {
                const existing = attMap.get(att.messageId) ?? [];
                existing.push(att);
                attMap.set(att.messageId, existing);
              }
            }
          }
          attachmentsByMsgIdRef.current = attMap;

          setThread(data.thread);
          const leafId = data.thread.currentLeafId ?? found.id;
          setMessages(buildChain(leafId));

          // Suppress unused variable warning — optimisticUser is used for
          // debugging if needed, but the server data is authoritative.
          void optimisticUser;

          return true;
        } catch {
          return false;
        }
      };

      // Try immediately, then poll every 1.5s until the assistant message appears.
      const maxAttempts = 40; // 60s max at 1.5s intervals
      let attempts = 0;
      const tryPoll = async () => {
        if (userStoppedRef.current) return;
        const found = await pollOnce();
        if (found) {
          resyncingRef.current = false;
          setIsStreaming(false);
          streamingAssistantIdRef.current = null;
          // Release wakeLock — streaming is effectively done.
          if (wakeLockRef.current) {
            wakeLockRef.current.release().catch(() => { /* non-fatal */ });
            wakeLockRef.current = null;
          }
          return;
        }
        attempts++;
        if (attempts >= maxAttempts) {
          resyncingRef.current = false;
          setIsStreaming(false);
          streamingAssistantIdRef.current = null;
          if (wakeLockRef.current) {
            wakeLockRef.current.release().catch(() => { /* non-fatal */ });
            wakeLockRef.current = null;
          }
          return;
        }
        pollRef.current = setTimeout(tryPoll, 1500);
      };

      void tryPoll();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        handleResync();
      }
    };

    const onPageShow = (e: PageTransitionEvent) => {
      // Safari BFCache: pageshow fires when returning from BFCache.
      // Only resync if the page was persisted (not a fresh load).
      if (e.persisted) handleResync();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
      // Reset resyncing so the next thread's streamChat finally block isn't skipped.
      resyncingRef.current = false;
    };
  }, [threadId]);

  const send = useCallback(
    async (
      input: string,
      opts?: { systemPrompt?: string; model?: string; attachmentIds?: string[]; rapid?: boolean; timeRange?: "day" | "week" | "month" | "year" },
    ) => {
      if (!threadId || !thread || isLoading || isStreaming) return;
      const trimmed = input.trim();
      if (!trimmed) return;

      const parentId = thread?.currentLeafId ?? null;
      const userMsg: ChatMessage = {
        id: `optimistic-user-${Date.now()}`,
        role: "user",
        content: trimmed,
        parentId,
      };
      const assistantId = `optimistic-assistant-${Date.now()}`;

      await streamChat(
        {
          threadId,
          content: trimmed,
          systemPrompt: opts?.systemPrompt,
          model: opts?.model,
          attachmentIds: opts?.attachmentIds,
          rapid: opts?.rapid ?? rapid,
          timeRange: opts?.timeRange ?? timeRange,
          mode: "send",
        },
        userMsg,
        assistantId,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, isStreaming, thread, isLoading, t, rapid, timeRange],
  );

  const regenerate = useCallback(
    async (userMessageId: string) => {
      if (!threadId || !thread || isLoading || isStreaming) return;

      const assistantId = `optimistic-regen-${Date.now()}`;
      await streamChat(
        {
          threadId,
          mode: "regenerate",
          parentMessageId: userMessageId,
          rapid,
          timeRange,
        },
        null,
        assistantId,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, isStreaming, thread, isLoading, t, rapid, timeRange],
  );

  const editMessage = useCallback(
    async (userMessageId: string, newContent: string) => {
      if (!threadId || !thread || isLoading || isStreaming) return;
      const trimmed = newContent.trim();
      if (!trimmed) return;

      const parentId = byIdRef.current.get(userMessageId)?.parentId ?? null;
      const userMsg: ChatMessage = {
        id: `optimistic-edit-${Date.now()}`,
        role: "user",
        content: trimmed,
        parentId,
      };
      const assistantId = `optimistic-edit-asst-${Date.now()}`;

      await streamChat(
        {
          threadId,
          content: trimmed,
          mode: "edit",
          parentMessageId: userMessageId,
          rapid,
          timeRange,
        },
        userMsg,
        assistantId,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, isStreaming, thread, isLoading, t, rapid, timeRange],
  );

  const switchBranch = useCallback(
    (messageId: string) => {
      if (thread) {
        setThread({ ...thread, currentLeafId: messageId });
        // Persist currentLeafId to server (show the same branch after reload).
        // Fire-and-forget: does not block instant UI switching.
        clientFetch(`/api/threads?id=${encodeURIComponent(thread.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentLeafId: messageId }),
        }).catch(() => { /* silent: UI has already switched */ });
      }
      setMessages(buildChain(messageId));
    },
    [thread],
  );

  const getSiblingInfo = useCallback(
    (messageId: string): { siblings: string[]; currentIndex: number } => {
      const msg = byIdRef.current.get(messageId);
      if (!msg) return { siblings: [messageId], currentIndex: 0 };
      // Root messages with null parentId are siblings only with themselves.
      // (prevents all roots from being treated as siblings due to null === null)
      if (msg.parentId === null) {
        return { siblings: [messageId], currentIndex: 0 };
      }
      const siblings: string[] = [];
      for (const [id, m] of byIdRef.current) {
        // Determine siblings by exact parentId match. null values are not siblings.
        if (m.parentId !== null && m.parentId === msg.parentId) {
          siblings.push(id);
        }
      }
      // byIdRef is a Map that preserves insertion order, so no sort is needed (creation order is maintained).
      return {
        siblings,
        currentIndex: siblings.indexOf(messageId),
      };
    },
    [],
  );

  const updateThread = useCallback(
    async (patch: {
      systemPrompt?: string | null;
      model?: string;
      responseMode?: "single" | "dual" | "hyper" | "council";
      dualModelA?: string | null;
      dualModelB?: string | null;
      dualDebateRounds?: number;
      hyperRounds?: number;
      councilSize?: number;
      councilTimeLimit?: number;
      mcpServerIds?: string[];
      connectionIds?: string[];
      globalInstructionId?: string | null;
    }) => {
      if (!threadId) return;
      try {
        const res = await clientFetch(`/api/threads?id=${encodeURIComponent(threadId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const updated = (await res.json()) as Thread;
        setThread(updated);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("chat.updateError"));
      }
    },
    [threadId, t],
  );

  const uploadAttachment = useCallback(
    async (file: File) => {
      try {
        if (!threadId) throw new Error(t("chat.uploadError"));
        const dataUrl = await fileToDataUrl(file);
        const res = await clientFetch("/api/upload", {
          method: "POST",
          body: (() => {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("threadId", threadId);
            return formData;
          })(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { id: string; filename: string; mimeType: string };
        const att: MessageAttachment = {
          id: data.id,
          messageId: null,
          filename: data.filename,
          mimeType: data.mimeType,
          dataUrl,
        };
        setPendingAttachments((prev) => [...prev, att]);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("chat.uploadError"));
      }
    },
    [threadId, t],
  );

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return {
    messages,
    thread,
    isStreaming,
    isLoading,
    error,
    sources,
    send,
    stop,
    clear,
    updateThread,
    regenerate,
    editMessage,
    switchBranch,
    getSiblingInfo,
    pendingAttachments,
    uploadAttachment,
    removeAttachment,
    rapid,
    setRapid,
    timeRange,
    setTimeRange,
  };
}

function parseSse(raw: string): { event: string; data: SseData } | null {
  let event = "message";
  let dataLine = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
  }
  if (!dataLine) return null;
  try {
    return { event, data: JSON.parse(dataLine) as SseData };
  } catch {
    return null;
  }
}

function fileToDataUrl(file: File): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
  return promise;
}
