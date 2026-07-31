> React hooks powering chat, threads, and folders — the client-side state layer of MinervaAIWorkspace.

**Relevant source files:**
- `src/hooks/useChat.ts` — core chat hook (single-thread, branching, SSE streaming)
- `src/hooks/useThreads.ts` — thread list CRUD
- `src/hooks/useFolders.ts` — folder list CRUD
- `src/lib/clientFetch.ts` — shared fetch wrapper with 401 handling

---

## Overview

MinervaAIWorkspace's frontend state is organized around three hooks that map cleanly to the three sidebar concerns: the active conversation (`useChat`), the thread list (`useThreads`), and the folder list (`useFolders`). All three use [`clientFetch`](#clientfetch-and-401-handling) for every network call so that expired sessions are handled uniformly.

| Hook | Purpose | Backing API |
|------|---------|-------------|
| `useChat(threadId)` | Single-thread chat: messages, branching, SSE streaming | `/api/threads/[id]`, `/api/chat` |
| `useThreads()` | Thread list (sidebar) | `/api/threads`, `/api/threads/[id]` |
| `useFolders()` | Folder list (sidebar) | `/api/folders`, `/api/folders/[id]` |

---

## useChat(threadId)

The central hook, instantiated once per active thread. It is a client component hook (`"use client"`) that lives in `src/hooks/useChat.ts` (~631 lines).

### State

```ts
const [messages, setMessages]         = useState<ChatMessage[]>([]);
const [thread, setThread]             = useState<Thread | null>(null);
const [isStreaming, setIsStreaming]   = useState(false);
const [isLoading, setIsLoading]       = useState(false);
const [error, setError]              = useState<string | null>(null);
const [sources, setSources]          = useState<SourceInfo[]>([]);
const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
const [rapid, setRapid]              = useState(false);
const [timeRange, setTimeRange]      = useState<"day"|"week"|"month"|"year"|null>(null);
```

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `ChatMessage[]` | The linear chain from root to the current leaf, rebuilt after every mutation. |
| `thread` | `Thread \| null` | Thread metadata (model, system prompt, `currentLeafId`, dual-mode config, MCP/connection IDs). |
| `isStreaming` | `boolean` | True while an SSE stream is active. |
| `isLoading` | `boolean` | True while a thread is being fetched on switch. |
| `error` | `string \| null` | Last user-facing error (load, stream, update, upload). |
| `sources` | `SourceInfo[]` | Search/scrape sources for the current response. |
| `pendingAttachments` | `MessageAttachment[]` | Files staged in the input area, not yet sent. |
| `rapid` | `boolean` | Rapid mode toggle (passed to the server). |
| `timeRange` | `"day"\|"week"\|"month"\|"year"\|null` | Time-bounded search filter. |

Two refs hold the authoritative branch state outside React's render cycle:

```ts
const abortRef = useRef<AbortController | null>(null);
const byIdRef  = useRef<Map<string, RawMessage>>(new Map());
const attachmentsByMsgIdRef = useRef<Map<string, RawAttachment[]>>(new Map());
```

`abortRef` is the live `AbortController` for the current stream; aborting it cancels the fetch and leaves partial content in place.

### byIdRef Map — the flat branch store

Instead of storing messages as a tree or a nested array, `useChat` keeps **every branch node** — including off-screen siblings — in a single flat `Map<string, RawMessage>` keyed by message ID:

```ts
type RawMessage = {
  id: string;
  parentId: string | null;
  role: ChatRole;
  content: string;
  reasoning?: string | null;
  statusLabel?: string;
  model?: string;
  elapsedMs?: number;
  metadata?: { dualTrace?: DualTrace; model?: string; elapsedMs?: number } | null;
};
```

This is the canonical source of truth. The `messages` state is only a **derived view** of this map, computed by walking the parent chain.

### buildChain(leafId) — reconstructing the linear view

`buildChain` walks `parentId` pointers from a leaf node up to the root, then reverses the collected nodes into chronological order:

```ts
function buildChain(leafId: string): ChatMessage[] {
  const chain: ChatMessage[] = [];
  let currentId: string | null = leafId;
  while (currentId) {
    const msg = byIdRef.current.get(currentId);
    if (!msg) break;
    chain.unshift({ /* mapped RawMessage → ChatMessage */ });
    currentId = msg.parentId;
  }
  return chain;
}
```

Every state mutation calls `setMessages(buildChain(leafId))` to refresh the visible list. Because `byIdRef` holds all siblings, switching branches is just a matter of building the chain from a different leaf — no refetch needed.

### Thread loading

A `useEffect` keyed on `threadId` handles loading:

```ts
useEffect(() => {
  if (!threadId) { /* clear maps + state */ return; }
  let cancelled = false;
  void (async () => {
    setIsLoading(true);
    const res = await clientFetch(`/api/threads/${threadId}`);
    const data = await res.json(); // { thread, messages, attachments }
    if (cancelled) return;
    // Build byId map from data.messages
    // Build attachmentsByMsgIdRef from data.attachments
    const leafId = data.thread.currentLeafId
      ?? data.messages[data.messages.length - 1]?.id ?? null;
    setMessages(leafId ? buildChain(leafId) : []);
  })();
  return () => {
    cancelled = true;
    abortRef.current?.abort(); // abort in-flight stream on switch
  };
}, [threadId, t]);
```

Key behaviors:
- **Aborts in-flight streams on thread switch.** The cleanup function calls `abortRef.current?.abort()` so the old thread's SSE deltas can't overwrite the newly-selected thread's state.
- **`currentLeafId` drives the initial view.** If the thread was saved pointing at a branch, that branch is shown on load.
- A `cancelled` guard prevents setState after unmount or re-entry.

### streamChat() — the shared streaming engine

`send`, `regenerate`, and `editMessage` are thin wrappers around one internal function, `streamChat(body, optimisticUser, assistantId)`. It:

1. **Writes optimistic nodes into `byIdRef`** — the user message (if any) and an empty assistant placeholder are inserted immediately so the UI shows them before the first network byte.
2. **Updates `thread.currentLeafId`** to the assistant placeholder and rebuilds the chain so the placeholder is visible.
3. **POSTs to `/api/chat`** with an `AbortController`, reads the response body as a stream, and splits SSE frames on `\n\n` boundaries.
4. **Dispatches each parsed event** to a handler that mutates `byIdRef` and calls `setMessages(buildChain(...))`.

```ts
async function streamChat(body, optimisticUser, assistantId) {
  // 1. Optimistic insert into byIdRef
  // 2. setThread({ ...thread, currentLeafId: assistantId })
  // 3. setMessages(buildChain(assistantId))
  // 4. const ac = new AbortController(); abortRef.current = ac;
  // 5. const res = await clientFetch("/api/chat", { ..., signal: ac.signal });
  // 6. Read stream, parse SSE frames, dispatch events
}
```

The three callers differ only in what they pass:

| Caller | `optimisticUser` | `body.mode` | `body.parentMessageId` |
|--------|------------------|-------------|-------------------------|
| `send(content, opts)` | new user message | `"send"` | — |
| `regenerate(userMsgId)` | `null` | `"regenerate"` | `userMsgId` |
| `editMessage(userMsgId, newContent)` | new user message (sibling of the edited one) | `"edit"` | `userMsgId` |

### SSE event handling

SSE frames are parsed by `parseSse(raw)`, which reads `event:` and `data:` lines and `JSON.parse`es the data. Each event type updates `byIdRef` and rebuilds the chain:

| Event | `data` fields | Action |
|-------|---------------|--------|
| `start` | `userMessageId` | **Optimistic ID swap**: replaces the optimistic user ID in `byIdRef` with the server-assigned real ID, reparents the assistant placeholder, and rebuilds. |
| `thinking` | `delta` | Appends `delta` to the assistant node's `reasoning` field (the "thinking" buffer). |
| `status` | `label` | Sets a transient `statusLabel` (e.g. "Searching…") shown while tools run. |
| `dual_trace` | `dualTrace` | Stores dual-model trace metadata (cross-review / debate) for the dual-trace UI. |
| `delta` | `delta` | Appends `delta` to the assistant's `content` and clears `statusLabel`. |
| `replace_content` | `content` | Replaces the assistant's content wholesale (used after tool calls rewrite the message). |
| `sources` | `sources` | Sets the `sources` state for the source chips. |
| `done` | `assistantMessageId`, `model`, `elapsedMs` | **Optimistic ID swap**: replaces the assistant placeholder ID with the real server ID, attaches `model`/`elapsedMs`, updates `thread.currentLeafId`, and rebuilds. |
| `error` | `message` | Sets `error` state. |

See [Chat & Streaming](./chat-streaming.md) for the server-side event emission and the full event lifecycle.

### Optimistic updates with ID swapping

Two events perform the signature **placeholder → real ID** swap:

1. **`start`** swaps the optimistic user ID (`optimistic-user-<ts>`) for `userMessageId` from the server. The assistant placeholder's `parentId` is patched to point at the new real user ID, so the chain remains consistent.
2. **`done`** swaps the optimistic assistant ID (`optimistic-assistant-<ts>`) for `assistantMessageId`, and stamps `model` and `elapsedMs` onto the node.

This pattern means the UI never blocks on a round-trip — placeholders render instantly, and the IDs are transparently rewritten when the server confirms persistence. The `byIdRef` Map makes the swap cheap: `delete(oldId)` + `set(realId, { ...oldMsg, id: realId })`.

### Branch switching

`switchBranch(messageId)` is an instant, client-only operation:

```ts
const switchBranch = useCallback((messageId: string) => {
  if (thread) {
    setThread({ ...thread, currentLeafId: messageId });
    clientFetch(`/api/threads?id=${encodeURIComponent(thread.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ currentLeafId: messageId }),
    }).catch(() => { /* silent: UI has already switched */ });
  }
  setMessages(buildChain(messageId));
}, [thread]);
```

- The UI switches **immediately** via `setMessages(buildChain(messageId))` — no await.
- A **fire-and-forget PATCH** persists `currentLeafId` to the server so the same branch shows after reload. Errors are silently swallowed because the UI is already correct.

`getSiblingInfo(messageId)` powers the `< 1/3 >` branch navigator. It scans `byIdRef` for all nodes sharing the same `parentId`:

```ts
const getSiblingInfo = useCallback((messageId): { siblings: string[]; currentIndex: number } => {
  const msg = byIdRef.current.get(messageId);
  if (!msg) return { siblings: [messageId], currentIndex: 0 };
  // Root messages (parentId === null) are only siblings with themselves.
  if (msg.parentId === null) return { siblings: [messageId], currentIndex: 0 };
  const siblings = [...byIdRef.current.values()]
    .filter((m) => m.parentId === msg.parentId)
    .map((m) => m.id);
  return { siblings, currentIndex: siblings.indexOf(messageId) };
}, []);
```

The `Map` preserves insertion order, so siblings are returned in creation order without sorting. The `null`-parentId guard prevents all root messages from being treated as mutual siblings.

### Other operations

- **`updateThread(patch)`** — `PATCH /api/threads?id=...` with a partial body (`systemPrompt`, `model`, `responseMode`, `dualModelA/B`, `dualDebateRounds`, `mcpServerIds`, `connectionIds`, `globalInstructionId`). Awaits the response and replaces `thread` with the server-returned object.
- **`uploadAttachment(file)`** — converts the file to a data URL (for preview), POSTs the `FormData` to `/api/upload`, and pushes the returned `{ id, filename, mimeType, dataUrl }` into `pendingAttachments`.
- **`removeAttachment(id)`** — filters the id out of `pendingAttachments`.
- **`stop()`** — aborts `abortRef.current`, leaving the partial response in place (the `AbortError` is caught and treated as a graceful stop).
- **`clear()`** — aborts if streaming, then resets `messages`, `error`, and `sources`.

### Return value

```ts
return {
  messages, thread, isStreaming, isLoading, error, sources,
  send, stop, clear, updateThread, regenerate, editMessage,
  switchBranch, getSiblingInfo,
  pendingAttachments, uploadAttachment, removeAttachment,
  rapid, setRapid, timeRange, setTimeRange,
};
```

---

## useThreads()

Sidebar thread list CRUD (`src/hooks/useThreads.ts`). Holds `ThreadSummary[]` and exposes:

| Method | HTTP | Description |
|--------|------|-------------|
| `refresh()` | `GET /api/threads` | Re-fetch the full list (called after sending a chat to refresh `updatedAt` ordering). |
| `create()` | `POST /api/threads` | Create a new thread; **prepends** the result to the list and returns it (`ThreadSummary \| null`). |
| `rename(id, title)` | `PATCH /api/threads?id=...` | Update the title; replaces the matching item in-place. |
| `move(id, folderId)` | `PATCH /api/threads?id=...` | Reassign to a folder (or `null` for no folder). |
| `remove(id)` | `DELETE /api/threads/[id]` | Delete; filters the id out of the list. |

All mutations follow the **optimistic-after-confirm** pattern: the fetch is awaited, and only on success does the local state update (prepend / map / filter). Errors set `error` and return `false`/`null` without mutating the list. An initial `useEffect` calls `refresh()` on mount.

```ts
export type ThreadSummary = {
  id: string;
  title: string;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
};
```

---

## useFolders()

Sidebar folder list CRUD (`src/hooks/useFolders.ts`). Structurally identical to `useThreads`, holding `FolderSummary[]`:

| Method | HTTP | Description |
|--------|------|-------------|
| `refresh()` | `GET /api/folders` | Re-fetch the list. |
| `create(body?)` | `POST /api/folders` | Create a folder (`{ name?, instruction?, memoryScope? }`); prepends and returns it. |
| `update(id, patch)` | `PATCH /api/folders?id=...` | Update name/instruction/memoryScope; replaces in-place. |
| `remove(id)` | `DELETE /api/folders/[id]` | Delete; filters the id out. |

```ts
export type FolderSummary = {
  id: string;
  name: string;
  instruction: string | null;
  memoryScope: "folder" | "global";
  createdAt: string;
  updatedAt: string;
};
```

Same confirm-then-mutate pattern as `useThreads`: the network call is awaited, and local state is updated only on a successful response.

---

## Key patterns

### Optimistic UI with ID swapping

`useChat` renders **placeholder messages** before the server responds. Each placeholder gets a throwaway ID (`optimistic-user-<ts>`, `optimistic-assistant-<ts>`). When the server emits `start` (for the user) and `done` (for the assistant), the placeholder ID is swapped for the real server-assigned ID inside `byIdRef`, and the chain is rebuilt. This keeps the UI responsive while guaranteeing the persisted IDs are correct.

### Branch tree stored in a flat Map

All branch nodes — including off-screen siblings from edits and regenerations — live in `byIdRef.current`, a `Map<string, RawMessage>`. The visible `messages` array is always a **derived view** produced by `buildChain(leafId)` walking `parentId` pointers to the root. This makes branch switching an O(depth) client operation with no refetch.

### Fire-and-forget persistence

`switchBranch` updates the UI instantly and persists `currentLeafId` to the server in a non-awaited PATCH. If the PATCH fails, the error is swallowed because the client state is already authoritative for the current session; the next thread load will re-fetch the server's stored value. This trades eventual consistency for perceived performance.

### clientFetch and 401 handling

Every hook imports `clientFetch` from `src/lib/clientFetch.ts` instead of calling `fetch` directly. The wrapper inspects the response status:

```ts
export async function clientFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    // Invalid session (e.g. JWT's userId no longer in the users table after a DB recreation).
    // Delete auth cookies to avoid an infinite /login → / → 401 → /login loop,
    // then redirect to /login.
    document.cookie.split(";").forEach((c) => { /* expire authjs*/next-auth cookies */ });
    window.location.href = "/login";
  }
  return res;
}
```

This centralizes session-expiry handling so individual hooks don't need to check `res.status === 401` themselves. See [Authentication](./authentication.md) for the session/JWT lifecycle.

---

## See also

- [Chat & Streaming](./chat-streaming.md) — the server-side `/api/chat` SSE endpoint and event lifecycle
- [Frontend](./frontend.md) — components that consume these hooks (`ChatWindow`, `Sidebar`)
- [API Routes](./api-routes.md) — the `/api/threads`, `/api/folders`, `/api/upload`, `/api/chat` endpoints
- [Authentication](./authentication.md) — sessions, JWTs, and the 401 flow
- [Architecture](./architecture.md) — overall system layout
