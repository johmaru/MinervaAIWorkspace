Chat and streaming subsystem — the SSE streaming pipeline, branching message tree, and three LLM interaction modes (normal, rapid, dual).

## Relevant source files

- `src/app/api/chat/route.ts` — the single chat endpoint (`POST /api/chat`); orchestrates context assembly, tool calling, dual-model flow, streaming, and post-stream work
- `src/hooks/useChat.ts` — client-side hook driving the branch-aware message tree and SSE consumption
- `src/lib/llm.ts` — OpenAI-compatible LLM client factory, model resolution, reasoning control
- `src/lib/toolProbe.ts` — startup probe for model function-calling support
- `src/lib/toolCallSanitizer.ts` — fallback sanitizer for models emitting tool-call syntax as plain text
- `src/lib/contextCompaction.ts` — history compaction utility (defined/tested, currently dormant)
- `src/components/ChatWindow.tsx` — message rendering, branch navigation, input area
- `src/components/ChatShell.tsx` — top-level chat layout, active thread state

---

## Overview

UmansChat's chat subsystem is a streaming pipeline built around an OpenAI-compatible API client. A single endpoint (`POST /api/chat`) orchestrates context assembly, optional search/tool execution, dual-model debate, and Server-Sent Events (SSE) streaming. The client (`useChat` hook) reads the SSE stream and drives a branch-aware message tree in the UI.

The route runs on the Node.js runtime — `export const runtime = "nodejs"; export const dynamic = "force-dynamic";` (`route.ts:42-43`) — because it is long-lived, does filesystem and child-process work (MCP stdio), and uses `after()` from `next/server`, which is not available on the Edge runtime.

Three LLM interaction modes exist, selected per-request:

| Mode | When | What it skips |
|---|---|---|
| **Normal (single)** | default | nothing — full pipeline |
| **Rapid** | `body.rapid === true` (⚡ toggle in UI) | search, URL context, memory/skill injection, tool probe, MCP/connections, post-stream memory generation |
| **Dual** | `thread.responseMode === "dual"` | pre-search system message (search context excluded for tool-supporting models); adds cross-review/debate flow |

At a high level, every request flows through the same stages: authenticate → load thread + all messages → resolve the turn (send/regenerate/edit) → resolve system prompt → assemble context in parallel → dispatch by mode → stream the answer as SSE → persist → run post-stream work via `after()`.

---

## Chat request flow

### Client: `useChat(threadId)`

The `useChat(threadId)` hook (`src/hooks/useChat.ts:109`) is the single source of truth for one conversation. It exposes `send`, `regenerate`, `editMessage`, `switchBranch`, `getSiblingInfo`, plus state (`messages`, `thread`, `isStreaming`, `sources`, `rapid`, `timeRange`).

All messages — across every branch — are kept in an in-memory `byIdRef: Map<string, RawMessage>` (`useChat.ts:123`). The *displayed* list is computed by `buildChain(leafId)` (`useChat.ts:127`), which walks `parentId` from a leaf up to the root, `unshift`-ing into an ascending `ChatMessage[]`. Attachments live in a parallel `attachmentsByMsgIdRef` map (`useChat.ts:124`).

On thread switch (effect, `useChat.ts:151`): fetches `GET /api/threads/{id}` → builds the `byId` map + attachments map → sets `thread` state → derives the display chain from `thread.currentLeafId` (falls back to last message id, `useChat.ts:198`). The cleanup aborts any in-flight stream (`useChat.ts:212`).

`send(content, opts)` (`useChat.ts:389`):

1. Guards against concurrent sends (`isLoading`, `isStreaming`).
2. Resolves `parentId = thread.currentLeafId` — the new user message hangs off the current leaf (`useChat.ts:398`).
3. Creates an **optimistic user message** with id `optimistic-user-${Date.now()}` (`useChat.ts:399`) and an **optimistic assistant placeholder** `optimistic-assistant-${Date.now()}`.
4. Delegates to the internal `streamChat()` helper.

`regenerate(userMessageId)` (`useChat.ts:426`) sends no new user message — it re-answers an *existing* user message. The body is `{ mode: "regenerate", parentMessageId: userMessageId }`. The server finds the user message by id and re-runs generation against its `parentId` chain.

`editMessage(userMessageId, newContent)` (`useChat.ts:447`) creates a *sibling* of the given user message (same `parentId`), then generates a new assistant under it. The body is `{ mode: "edit", parentMessageId: userMessageId, content }`.

### `streamChat()` — the streaming core

`streamChat(body, optimisticUser, assistantId)` (`useChat.ts:228`):

1. Inserts the optimistic user (if any) and assistant placeholder into `byIdRef`, sets `thread.currentLeafId = assistantId`, and rebuilds the display chain (`useChat.ts:233-254`). This gives instant UI feedback before the server responds.
2. Creates an `AbortController` (stored in `abortRef`, `useChat.ts:260`) — this is how `stop()` works (`useChat.ts:216`).
3. `POST /api/chat` with the JSON body and the abort signal (`useChat.ts:263`).
4. Reads `res.body` as a streaming reader, decodes bytes, buffers, and splits on `\n\n` into SSE frames (`useChat.ts:284`).
5. Each frame is parsed by `parseSse()` (`useChat.ts:608`): extracts `event:` and `data:` lines, JSON-parses the data.
6. Dispatches on `event.event`. On `start`, the optimistic user id is swapped for the real server id (`useChat.ts:290-304`); on `done`, the optimistic assistant id is swapped for the real one (`useChat.ts:355-371`).
7. On `AbortError`: the partial response is kept as-is (`useChat.ts:378`). On other errors: `setError`.
8. `finally`: `setIsStreaming(false)`, clear `abortRef` (`useChat.ts:383-386`).

### API: `POST(req)` — `src/app/api/chat/route.ts`

At **module load**, `warmupToolProbe()` (`route.ts:47`) kicks off the tool-support probe in the background (a `queueMicrotask`) to hide ~750ms latency on the first real request.

`POST(req)` (`route.ts:83`):

1. **Auth & parse** (`route.ts:84-92`): `getSessionUser()` → 401 if none. Parse JSON body as `Body` (`route.ts:51`): `{ threadId, content?, systemPrompt?, model?, mode?: "send"|"regenerate"|"edit", parentMessageId?, rapid?, timeRange? }`.
2. **Load thread** (`route.ts:96-98`): `threads` row by `threadId`; 404 if missing or not owned by the user.
3. **Load all messages** (`route.ts:100-109`): `SELECT id, parentId, role, content FROM messages WHERE threadId ORDER BY createdAt, id`. This is the *entire* branch tree — every node, all branches — loaded at once.
4. **`prepareTurn()`** (`route.ts:112`): resolves the user message + history chain + content for this turn.
5. **Resolve system prompt** (`route.ts:115-155`): priority cascade (see [System prompt resolution](#system-prompt-resolution)).
6. **Tool probe promise** (`route.ts:170-172`): `body.rapid ? Promise.resolve(null) : probeToolSupport(...).catch(() => null)`. Started early to overlap with the pre-stream parallel work.
7. **Stream setup** (`route.ts:177-181`): a `streamDone` promise + `streamResult.assistantContent` object — the bridge to the `after()` callback (see [after() + streamDone pattern](#after--streamdone-pattern)).
8. **Create `ReadableStream<Uint8Array>`** (`route.ts:183`). Inside `start(controller)`:
   - `send` helper (`route.ts:187-188`): `controller.enqueue(encoder.encode(\`event: ${event}\ndata: ${JSON.stringify(data)}\n\n\`))` — the SSE frame writer.
   - `send("start", { userMessageId: prepared.userMessage.id })` (`route.ts:196`).
9. **Pre-stream context assembly** (`route.ts:200-239`) — runs in `Promise.all` (skipped entirely in rapid mode, where all four are `null`). Each is `.catch(() => null)` so a failure in one does not block the others.
10. **MCP servers** (`route.ts:244-272`): for each id in `thread.mcpServerIds`, fetch the config, `connectMcpServer`, `listMcpTools`. Non-blocking on failure. Connections are closed in `finally` (`route.ts:478-480`).
11. **Connections** (`route.ts:277-289`): `loadConnections` + `getConnectionTools` for `thread.connectionIds`. Stateless HTTP APIs (currently Notion only).
12. **`buildFinalMessages()`** (`route.ts:291-300`): assembles the OpenAI message array (see [Context assembly](#context-assembly)).
13. **Mode dispatch** (`route.ts:302-388`): dual → rapid → normal (see respective sections below).
14. **Tool-call markup workaround** (`route.ts:390-427`): if the streamed assistant content contains tool-call syntax as plain text, sanitize it, `send("replace_content", {content})`, then re-stream with a continuation prompt. Max once.
15. **Persist** (`route.ts:428-448`): insert the assistant message (with `reasoning`, `metadata: { dualTrace?, model, elapsedMs }`), set `thread.currentLeafId = assistantMsg.id`, `send("done", {assistantMessageId, model, elapsedMs})`.
16. **Error path** (`route.ts:449-467`): if any content was produced, persist it as a partial assistant message and update the leaf — so aborted/errored streams still leave a trace.
17. **finally** (`route.ts:468-487`): bump `thread.updatedAt`, copy `assistantContent` into `streamResult`, close MCP connections, `controller.close()`, `resolveStream()`.
18. **`after()` callback** (`route.ts:498-543`) — runs after the response completes (see [after() + streamDone pattern](#after--streamdone-pattern)).
19. **Response** (`route.ts:545-551`): `new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive" } })`.

---

## SSE event protocol

The server emits SSE frames via the `send(event, data)` closure (`route.ts:187`). Frame format: `event: <name>\ndata: <json>\n\n`. The client parses them in `parseSse()` (`useChat.ts:608`) and dispatches in `streamChat()` (`useChat.ts:290-374`).

| Event | Payload shape | Emitted by | Client handler |
|---|---|---|---|
| `start` | `{ userMessageId: string }` | `route.ts:196` | Swaps optimistic user id → real id; updates assistant's `parentId`; rebuilds chain (`useChat.ts:290-304`) |
| `status` | `{ label: string }` | `route.ts:303,394,643,645,719,738,779,1242,1257,1280,1300,1322,1362` | Sets `statusLabel` on the assistant placeholder (`useChat.ts:315-323`). Shown as a spinner+label in the UI. |
| `thinking` | `{ delta: string }` | `route.ts:323,342,378,422` (via `onReasoning`) | Appends to `reasoning`; rebuilds chain (`useChat.ts:305-314`). Rendered in `ThinkingBlock` collapsible. |
| `delta` | `{ delta: string }` | `route.ts:319,338,374,418` (via `onDelta`) | Appends to `content`; clears `statusLabel` (`useChat.ts:333-342`). The streamed answer text. |
| `replace_content` | `{ content: string }` | `route.ts:398` | **Replaces** (not appends) the assistant content — used after sanitizing tool-call markup (`useChat.ts:343-352`) |
| `sources` | `{ sources: SourceInfo[] }` where `SourceInfo = { url, title, snippet }` | `route.ts:666,726,777,1359` | `setSources(...)` — shown in the references panel under the last assistant message (`useChat.ts:353-354`) |
| `dual_trace` | `{ dualTrace: DualTrace }` | `route.ts:312` | Stores `dualTrace` in the assistant message `metadata`; rendered in `DualTraceDetails` (`useChat.ts:324-332`). See [Dual-model mode](#dual-model-mode-cross-review--debate). |
| `done` | `{ assistantMessageId: string, model: string, elapsedMs: number }` | `route.ts:448` | Swaps optimistic assistant id → real id; stores `model` + `elapsedMs`; updates `thread.currentLeafId`; rebuilds chain (`useChat.ts:355-371`) |
| `error` | `{ message: string }` | `route.ts:467` | `setError(message)` (`useChat.ts:372-374`) |

Notes:

- The `done` event is always the last data event; the server then closes the stream.
- On error mid-stream, if partial content exists, it is still persisted server-side (`route.ts:450-466`) before `error` is sent.
- The `sources` event can fire multiple times (once per `buildUrlContext`, once per `buildSearchContext` wiki/web, once per tool round).
- `status` is purely cosmetic — it does not change message content, only the `statusLabel` shown in the spinner.

---

## Branching model

UmansChat implements a **tree-structured message store**. Every message has a `parentId` (nullable for roots). A thread has a single `currentLeafId` pointing at the currently-displayed leaf.

### Data model

- `messages` table: `{ id, threadId, parentId (nullable), role, content, reasoning, metadata, createdAt }`.
- `threads.currentLeafId`: the leaf of the currently-shown conversation path.

### How branches are created

Both `edit` and `regenerate` create **siblings** — new messages sharing a `parentId` with an existing message:

- **Edit** (`useChat.editMessage` → API `mode: "edit"`): the user edits message `M` (a user message). `prepareTurn` computes `parentId = M.parentId` (`route.ts:580-582`) and inserts a new user message with that parent — a sibling of `M`. A new assistant is then generated under it. The old branch is untouched.
- **Regenerate** (`useChat.regenerate` → API `mode: "regenerate"`): `prepareTurn` finds the user message `U` by `parentMessageId` and does **not** insert a new user row (`route.ts:563-572`). It re-answers `U`, and the new assistant message is inserted with `parentId: prepared.userMessage.id` = `U.id` (`route.ts:433`). Since the *previous* assistant also had `parentId: U.id`, the new one is its sibling.
- **Send** (`mode: "send"`): `parentId = thread.currentLeafId` (`route.ts:583`). If the user sends a new message right after an existing assistant, it's a *child* of that assistant — extending the current branch, not a sibling.

### Leaf management

After the assistant is persisted, the server updates `thread.currentLeafId = assistantMsg.id` (`route.ts:443-446`). So the newest branch always becomes the active leaf. The client mirrors this: `streamChat` optimistically sets `currentLeafId = assistantId` (`useChat.ts:251`), and `done` swaps to the real id (`useChat.ts:369`).

### Navigation (`getSiblingInfo`)

Given a `messageId` (`useChat.ts:496`), finds all messages in `byIdRef` with the **same `parentId`** (`route.ts:505-511`). Returns `{ siblings: string[], currentIndex }`. Key edge case: messages with `parentId === null` are treated as siblings *only of themselves* (`useChat.ts:502-504`) — this prevents all root messages from being (incorrectly) grouped as siblings. Sibling order follows `byIdRef` Map insertion order (creation order, `useChat.ts:512`) — no explicit sort.

### UI navigation (`BranchNav`)

When `siblings.length > 1`, a `< 2/3 >` control renders under the message (`ChatWindow.tsx:753`). `onPrev`/`onNext` call `onSwitchBranch(siblings[currentIndex ± 1])`, which calls `useChat.switchBranch(messageId)` — this updates `thread.currentLeafId` (optimistically + PATCH to server, `useChat.ts:479-494`) and rebuilds the display chain from that message. Switching branches changes which sibling (and its descendants) is shown.

### Branch persistence

`switchBranch` PATCHes `currentLeafId` to `PATCH /api/threads?id=...` (`useChat.ts:485-489`), handled at `src/app/api/threads/route.ts:124` (`if (body.currentLeafId !== undefined) values.currentLeafId = body.currentLeafId`). On reload, `GET /api/threads/[id]` returns all messages + the thread's `currentLeafId`, and the client rebuilds the chain from it (`useChat.ts:198`).

For more on the client hooks that drive this, see [Hooks & State](./hooks.md).

---

## Dual-model mode (cross-review / debate)

Enabled when `thread.responseMode === "dual"` (checked at `route.ts:302`). When active, the request runs `runDualModelFlow()` *before* the final streamed answer, and the trace is sent to the client via the `dual_trace` SSE event.

### `runDualModelFlow()` (`route.ts:872`)

1. **Resolve two models** (`resolveDualModels`, `route.ts:936`): `modelA = thread.dualModelA || finalModel`; `modelB = thread.dualModelB || (first available model ≠ modelA)`. Falls back to `finalModel` if no other model exists.
2. **Generate two independent answers** (`route.ts:888-891`): `completeText(modelA, withDualInstruction(baseMessages, "You are model A. Give your best independent answer."))` and the same for model B. `withDualInstruction` (`route.ts:944`) appends a system message: `"{instruction}\nDo not mention that another model will review you. Answer the user directly."`. These are **non-streaming** `completeText` calls (`stream:false`).
3. **Strategy branch** (`route.ts:893-934`):
   - **Debate** (`thread.dualStrategy === "debate"`): `runDebateTurns()` — then `trace = { strategy: "debate", modelA, modelB, finalModel, answerA, answerB, debateTurns }`.
   - **Cross-review** (default): model A reviews model B's answer, model B reviews model A's (`route.ts:907-921`). Each review is a `completeText` with the base messages + both answers + `"Review Model X's answer. Identify strengths, gaps, and corrections. Be concise."`. `trace = { strategy: "cross_review", ..., reviewA, reviewB }`.
4. **Build synthesis messages** (`buildSynthesisMessages`, `route.ts:1012`): `baseMessages` + a system message `"You are the final synthesizer. Use the dual-model work below..."` + an assistant message containing `JSON.stringify(trace)` + a user message `"Give the final answer based on the dual-model trace."`.
5. Returns `{ trace, finalMessages }`.

### `runDebateTurns()` (`route.ts:957`)

Clamps rounds to `[1, 5]` (default 2). For each round: builds a transcript via `formatDebateTranscript()` (`route.ts:1000`), which concatenates `Initial answer A`, `Initial answer B`, and all prior turns. Each speaker (A then B) gets a `completeText` with baseMessages + transcript-as-assistant + `"As model X, respond to the debate so far with concise corrections or support."`. Turns accumulate in `debateTurns: { speaker: "A"|"B", model, content }[]`.

### Extra LLM calls

| Strategy | Non-streaming calls before final stream |
|---|---|
| cross_review | 2 (answerA, answerB) + 2 (reviewA, reviewB) = **4** |
| debate | 2 (answerA, answerB) + 2×rounds (debate turns) = **2 + 2×rounds** |

The final synthesis answer is then **streamed** via `streamCompletion(dual.finalMessages)` (`route.ts:313-327`) — the user sees `status` events for each stage ("モデルAが回答中…", "モデルBが回答中…", "レビュー中…", "議論中… 1/N") and the `dual_trace` event, then the final streamed answer.

### Client rendering

`DualTraceDetails` (`ChatWindow.tsx:706`) renders inside an `Accordion` under the assistant message, showing `finalModel`, then `answerA`/`answerB` in `TraceSection` blocks, then either `reviewA`/`reviewB` (cross_review) or the debate turns (debate). The `DualTrace` type is defined identically on both client (`useChat.ts:9`) and server (`route.ts:69`).

### Note on dual + tool support

Dual mode excludes pre-search when tools are supported (`route.ts:356-367`) — but dual mode itself doesn't pass tools to `streamCompletion` (`route.ts:313-327`), so dual + tool-support just means the final synthesis stream has no tools.

---

## Rapid mode

**Toggle:** the ⚡ button in `ChatWindow` (`ChatWindow.tsx:377-389`) calls `setRapid(v => !v)`. `rapid` is `useChat` state (`useChat.ts:118`) passed through to each `send`/`regenerate`/`editMessage` as `opts.rapid ?? rapid` (`useChat.ts:414, 436, 469`), and into the request body as `rapid` (`useChat.ts:410`). The button reflects state via `aria-pressed` and a highlighted background.

**What rapid skips** (server-side, `route.ts`):

| Stage | Normal | Rapid |
|---|---|---|
| Tool probe promise (`170`) | `probeToolSupport(...)` | `Promise.resolve(null)` |
| Pre-stream context (`200-239`) | `buildSearchContext`, `buildUrlContext`, `buildMemoryContext`, `buildSkillContext` | all four forced to `null` (`201-203`) |
| MCP/connections (`244-289`) | loaded | skipped |
| `buildFinalMessages` (`291`) | full assembly | runs, but all context messages are null → just `[envCtx, system, history, user]` |
| Stream dispatch (`328-388`) | tool-use round-trips | direct `streamCompletion(finalMessages)` with **no** `toolSupport`/`send`/`extraTools` (`329-346`) |
| Post-stream `after()` (`498-543`) | `generateMemories` + skill extraction | early-returns (`502: if (body.rapid) return;`) |

Net effect: rapid mode is a pure LLM round-trip — no search, no memory recall, no skill injection, no tool use, no memory generation. Optimized for latency on simple follow-ups.

---

## Context assembly

### `buildFinalMessages()` (`route.ts:838`)

Constructs the final `ChatCompletionMessageParam[]` in a fixed order:

```text
[0] system: getEnvContext()          // "Current date: …\nEnvironment: …" (route.ts:858)
[1] system: personalizationContent?  // only if non-null (859)
[2] system: systemContent?           // folder+global+thread prompt (860)
[3] system: skillMessage?            // skillStore output (861)
[4] system: memoryMessage?           // memoryStore output (862)
[5..] history.map(role, content)     // the parent chain (863-865)
[ ] system: searchContextMessage?    // web/wiki/url context (866)
[ ] system: urlContextMessage?        // scraped URL content (867)
[last] user: content                 // the current turn (868)
```

`getEnvContext()` (`route.ts:814`) injects `Current date` + `Environment: <os> (<arch>)` using `process.env.HOST_OS`, auto-detected via `detectHostOs()` (`route.ts:822`, reads `/proc/version`) if unset, and timezone from `process.env.TZ` (default `Asia/Tokyo`).

### Pre-stream `Promise.all` (`route.ts:200-239`)

Four context builders run in parallel, each isolated with `.catch(() => null)` so a failure in one doesn't block the others:

- `buildSearchContext` (`route.ts:204-214`) — search decision + web/wiki results. Skipped entirely in rapid mode.
- `buildUrlContext` (`route.ts:215-221`) — scrape URLs found in the user message.
- `buildMemoryContext` (`route.ts:222-230`) — semantic memory recall. See [Memory System](./memory.md).
- `buildSkillContext` (`route.ts:231-238`) — skill retrieval. See [Skills System](./skills.md).

The resulting system messages are placed into `buildFinalMessages()` at fixed positions (`route.ts:861-862`): **skill message before memory message**, both after the system prompt and before history.

### `buildChain()` (server, `route.ts:610`)

Server-side mirror of the client's chain builder. Takes the flat `allMessages` array + a `leafId`, builds a `Map<id, msg>`, walks `parentId` from leaf to root, `unshift`s into an ascending array. Returns the linear history for the current branch.

### `prepareTurn()` (`route.ts:554`)

Resolves the turn's user message + history based on `mode`:

| mode | behavior |
|---|---|
| **regenerate** | requires `parentMessageId` pointing at a *user* message; reuses its content; history = `buildChain(allMessages, userMessage.parentId)` — i.e. everything *above* the user message. **Does not insert a new user row.** (`route.ts:563-572`) |
| **send** | `parentId = thread.currentLeafId`; inserts a **new user message** with that parent; history = `buildChain(allMessages, parentId)`. If the thread title is still "New chat" and history is empty, sets the title to the first 40 chars of content (`route.ts:595-601`). (`route.ts:574-601`) |
| **edit** | `parentId` = the *parent* of the referenced user message (i.e. its sibling). Inserts a new user message with that parent, creating a sibling branch. history = `buildChain(allMessages, parentId)`. (`route.ts:576-587`) |

Returns `{ content, userMessage, history }` or `{ error, status }`.

---

## after() + streamDone pattern

After `return new Response(stream, ...)` (`route.ts:545`), the HTTP response is sent and the request context would normally be lost. To run async post-stream work (memory generation, skill extraction) *after the stream completes* but *within the Next.js request lifecycle*, the route uses the **`after()`** primitive from `next/server` (imported `route.ts:22`) combined with a **promise bridge**.

### The problem it solves

`generateMemories` needs to run after the stream completes, but the HTTP response (the SSE stream) is already being sent. The constraints:

- A blocking `await` before `controller.close()` keeps the client's `isStreaming` high and freezes the UI.
- A bare `void` after `close()` is cancelled by the Next.js runtime (the request is done).
- Calling `after()` inside the `ReadableStream` `start()` callback silently fails because the request context (`waitUntil`) is already gone.

### The solution — a promise bridge

1. **In the POST handler body** (`route.ts:177-181`), *before* the `ReadableStream` is created:

   ```typescript
   let resolveStream!: () => void;
   const streamDone = new Promise<void>((resolve) => { resolveStream = resolve; });
   const streamResult: { assistantContent: string } = { assistantContent: '' };
   ```

   - **`streamDone`**: a promise that resolves when the stream finishes. `after()` awaits it.
   - **`streamResult`**: a mutable object — the only way to pass the final assistant content *out* of the stream closure (closures capture by reference) into the `after()` callback, which runs in a different scope/tick.

2. **Inside the stream** (`route.ts:468-487`), the `finally` block before `controller.close()`:
   - `streamResult.assistantContent = assistantContent` (`route.ts:475`) — copy accumulated content into the shared object.
   - Close MCP connections (`route.ts:478-480`), including stdio child-process termination via `conn.client.close()`.
   - `controller.close()` (`route.ts:483`) — client receives end-of-stream.
   - `resolveStream()` (`route.ts:486`) — **unblocks `after()`**.

3. **`after()` callback** (`route.ts:498-543`), registered in the POST handler body (request scope):

   ```typescript
   after(async () => {
     await streamDone;                            // wait for stream to finish
     if (!streamResult.assistantContent) return;  // nothing to process
     if (body.rapid) return;                      // rapid skips all post-processing

     // 1. Memory generation
     try { await generateMemories(threadId, [...], llm, finalModel, user.id); }
     catch (err) { console.error('[memory] generation failed:', err); }

     // 2. Skill generation -- two sub-modes (explicit "save as skill" vs auto-extract)
     // ...see below
   });
   ```

### Why `after()` must be in the POST body, not in `ReadableStream.start()`

The comment at `route.ts:491-497` explains: **`after()` must be called within the request context** (the POST body). The `ReadableStream` `start()` callback runs as a detached continuation — by the time it executes, the request scope that backs `waitUntil` is no longer active, so a call to `after()` there is silently dropped and the callback never executes. By calling `after()` in the POST body (`route.ts:498`) — *before* the `ReadableStream` is even constructed — and bridging via `streamDone` + `streamResult`, the callback is registered in the live request scope. It then `await`s `streamDone` (which resolves in the stream's `finally`), and runs using Next.js's `waitUntil` under the hood so the process persists post-close.

Errors are swallowed (the stream is already complete) and only logged.

### The three post-stream jobs

1. **`generateMemories`** (`src/lib/memory.ts:194`): takes the user + assistant turn, generates persistent memories for the user. **Always runs** (non-rapid). See [Memory System](./memory.md).
2. **`generateSkillFromConversation`** (`src/lib/skillGenerator.ts:108`): runs **only** when the user explicitly says "save as skill" (regex on `prepared.content`, `route.ts:519` — matches Japanese "skill de save" / "skill toshite save" and English "save as skill"). See [Skills System](./skills.md).
3. **`extractSkillCandidates`** (`src/lib/skillCandidate.ts:109`): runs when *no* explicit save request, but the conversation is **substantive** — either total length > 200 chars, or contains code/error/exception/config/bug/fix/debug keywords (`route.ts:530-534`). Extracts skill *candidates* (not finalized skills).

### Injection vs. generation — important distinction

- **Injection** (pre-stream, [Context assembly](#context-assembly)): *reads* existing memories/skills and injects them into the LLM context **before** streaming. Happens in `ReadableStream.start()`.
- **Generation** (post-stream, this section): *creates new* memories/skills from the just-completed conversation **after** the stream. Happens in `after()`.

---

## System prompt resolution

The system prompt is resolved via a priority cascade (`route.ts:115-155`):

1. **Model**: `finalModel = body.model ?? thread.model ?? defaultModel()` (`route.ts:116`).
2. **Global instruction**: `thread.globalInstructionId ?? userRow.activeInstructionId` → fetch content from `globalInstructions` (`route.ts:119-139`).
3. **Folder instruction** (via `thread.folderId`): fetched from `folders`, ownership-checked (`route.ts:142-149`).
4. **Final system content** (`route.ts:151-155`): `thread.systemPrompt ?? resolvedGlobalInstruction ?? body.systemPrompt`; if a folder instruction exists, it is **prepended** (`folderInstruction + "\n" + base`).
5. **Personalization message** (`route.ts:157-164`): `buildPersonalizationMessage(style, warmth, energy, structure, emoji)` — disabled (null) when `personalStyle` is null.

So the effective priority cascade for the system prompt body is: **thread.systemPrompt > global instruction > body.systemPrompt**, with a folder instruction prepended on top if present.

---

## LLM client (`src/lib/llm.ts`)

### `createLLM()` (`src/lib/llm.ts:7`)

Constructs an OpenAI SDK client with `baseURL = process.env.LLM_BASE_URL` (throws if unset) and `apiKey = process.env.LLM_API_KEY ?? 'missing'`. This single client backs all chat, search, memory, and skill calls. It's OpenAI-compatible — works with UmansAI, OpenAI, vLLM, Ollama, etc.

### Model resolution

- `defaultModel()` (`src/lib/llm.ts:18`): `process.env.LLM_MODEL ?? 'umans-glm-5.2'`
- `defaultSearchModel()` (`src/lib/llm.ts:23`): `process.env.WEB_SEARCH_MODEL || 'umans-qwen3.6-35b-a3b'`
- `embedModel()` (`src/lib/llm.ts:27`): `process.env.EMBED_MODEL ?? 'text-embedding-3-small'`
- `isUmansProvider()` (`src/lib/llm.ts:32`): `LLM_BASE_URL.includes('api.code.umans.ai')` — gates Umans-specific behavior (model info fetch, reasoning config).
- `availableModels()` (`src/lib/llm.ts:46`): in Umans mode, fetches from `/v1/models/info` (cached via `getUmansModels`); otherwise splits `LLM_MODELS` env by comma; falls back to `[defaultModel()]`.

### Reasoning control

`MODEL_REASONING` (`src/lib/llm.ts:71`) is a hardcoded table of `{ levels, defaultLevel, canDisable }` per model. In Umans mode, these are **overridden** by the API response from `getUmansModels()` (`src/lib/llm.ts:109`, cached in-process, refreshed via `resetUmansModelsCache()`).

| Model | levels | defaultLevel | canDisable |
|---|---|---|---|
| umans-glm-5.2 | [none,high,max] | high | true |
| umans-glm-5.1 | [none,medium] | medium | true |
| umans-qwen3.6-35b-a3b | [none,low,medium,high] | medium | true |
| umans-flash | [none,low,medium,high] | medium | true |
| umans-kimi-k2.6/k2.7, umans-coder | [] | null | false |

- `getReasoningLevels(model)` (`src/lib/llm.ts:170`): valid effort levels. Empty array = not controllable (no `reasoning_effort` sent).
- `getDefaultReasoningEffort(model)` (`src/lib/llm.ts:183`): default level, or null.
- `canDisableThinking(model)` (`src/lib/llm.ts:196`): whether `enable_thinking: false` fully disables thinking.
- **`buildDisableReasoningParams(model)`** (`src/lib/llm.ts:216`): **priority cascade** —
  1. if `canDisable` → `{ enable_thinking: false }` (GLM-5.2 ignores `reasoning_effort: 'none'`, so this takes precedence)
  2. else if `levels` includes `'none'` → `{ reasoning_effort: 'none' }`
  3. else `{}` (not controllable)

Used in `decideSearch`, tool-use rounds (`route.ts:1151`), and (dormant) compaction to suppress thinking tokens for latency.

### `completeText()` (`route.ts:1028`)

A thin non-streaming helper: `llm.chat.completions.create({ model, messages, stream: false, max_tokens?, reasoning_effort?, ...disableParams })` → returns `choices[0].message.content.trim()`. Used by the dual-model flow (all answer/review/debate/synthesis calls are non-streaming).

---

## Context compaction (dormant)

> **WARNING: Defined and unit-tested but NOT used in production.** A grep confirms `compactHistory` is imported **only** by `src/lib/contextCompaction.test.ts` — never by `route.ts` or any other production code. It exists as a utility but is currently **dormant**.

For documentation purposes, its design (`src/lib/contextCompaction.ts`):

- **`estimateTokens(text)`** (`src/lib/contextCompaction.ts:17`): heuristic — CJK chars (U+3000-U+9FFF, U+FF00-U+FFEF) approx 1 token, others approx 4 chars/token. Conservative overestimate (safety margin for the 80% threshold).
- **`estimateMessagesTokens(messages)`** (`src/lib/contextCompaction.ts:40`): sum of per-message token estimates + 4 overhead each (role tags, formatting).
- **`compactHistory({ history, llm, model })`** (`src/lib/contextCompaction.ts:58`):
  - if `history.length <= 6` → return as-is (too short to summarize)
  - otherwise: `toSummarize = history.slice(0, -4)`, `recent = history.slice(-4)` (keep last 2 turns)
  - summarize `toSummarize` via an LLM call (Japanese summary prompt, `max_tokens: 1024`, `temperature: 0.3`, `stream: false`)
  - return `[summaryMsg, ...recent]` where `summaryMsg = { id: 'compacted-summary', parentId: null, role: 'system', content: '## Past conversation summary' + summary }`
  - on error: return the original history unchanged (non-blocking)

Since it's not wired in, the current chat route sends the **full** `buildChain` history to the LLM with no compaction. This is a latent capability / potential future integration point.

---

## Tool calling summary

There are **two parallel tool-calling paths**, gated by the tool-support probe. Full details are in [Tool Calling](./tool-calling.md).

### Path A: Pre-search (non-tool-supporting models)

When `probeToolSupport` returns `supported: false` (e.g. GLM-5.2), the model can't do function calling. Instead, `buildSearchContext()` (`route.ts:675`) decides *whether* to search **before** streaming, via `decideSearch()` (`src/lib/searchDecision.ts:233`), and injects results as a system message. The model then answers in a single stream.

### Path B: In-stream function calling (tool-supporting models)

When `probeToolSupport` returns `supported: true`, the search system message is **excluded** (`route.ts:356-367`) and tools are passed to `streamCompletion`. Three built-in tools (`STREAM_TOOLS`, `route.ts:1050`): `scrape_webpage(url)`, `search_web(query)`, `search_wikipedia(query)`. Plus `extraTools` from MCP and connections, merged at `route.ts:382`.

### Tool-call markup sanitizer

`src/lib/toolCallSanitizer.ts` is a fallback for models that *don't* support function calling but emit tool-call syntax as **plain text** (e.g. GLM-5.2 may output fenced `search_web` blocks or XML tags). `hasToolCallMarkup(content)` detects these patterns; `sanitizeToolCallMarkup(content)` strips them via 9 regex passes (handling both complete and partial/streaming forms). When detected after streaming, the server replaces the content and re-streams with a prompt to answer directly — single-shot, no loop risk. Also used client-side by `Markdown.tsx` to avoid rendering broken fences.

### Tool probe (`src/lib/toolProbe.ts`)

A startup probe determines whether the configured LLM stably supports function calling. `probeToolSupport(llm, model)` (`src/lib/toolProbe.ts:61`) sends a non-streaming request with a dummy `search_web` definition and the message "Return the string 'probe-ok' without calling any tool." Cached in-process; started at module load via `warmupToolProbe()` so the ~750ms probe latency is hidden before the first real request. See [Tool Calling](./tool-calling.md) for full details.

---

## Key edge cases and invariants

1. **Optimistic id swap**: client uses fake ids (`optimistic-user-*`, `optimistic-assistant-*`) pre-server-response, then swaps them on `start`/`done` events. The `byIdRef` map is mutated in place (delete old key, set new key) and the chain is rebuilt (`useChat.ts:290-304, 355-371`).
2. **Abort preserves partial content**: `stop()` aborts; the `AbortError` is caught (`useChat.ts:378`) and the partial assistant content remains displayed. Server-side, the catch block also persists partial content as a message (`route.ts:450-466`).
3. **Thread switch aborts in-flight streams** (`useChat.ts:212`) — prevents the old thread's SSE from overwriting the new thread's state.
4. **Tool-call markup workaround** is a single-shot regeneration (`route.ts:390-427`) — no infinite loop risk.
5. **Tool rounds are capped** at `MAX_TOOL_ROUNDS = 3` (`route.ts:1097`); after that, the model streams a final answer without tools.
6. **MCP connections are request-scoped** — opened in `start`, closed in `finally` (`route.ts:478-480`), including stdio child-process termination.
7. **OAuth token refresh** for connection tools is persisted to DB on each call (`route.ts:1333-1341`).
8. **Root messages are not siblings** — `getSiblingInfo` special-cases `parentId === null` (`useChat.ts:502-504`) to avoid grouping all roots.
9. **`compactHistory` is dormant** — defined and tested but not imported by `route.ts`. History is currently sent uncompacted.
10. **`after()` requires the request context** — it's called in the POST body (`route.ts:498`), not inside `ReadableStream.start()`, bridged by `streamDone` + `streamResult` (`route.ts:177-181, 491-497`).
11. **Rapid mode is end-to-end minimal** — skips pre-stream context, tool probe, in-stream tools, and post-stream memory/skill generation.
12. **Dual mode excludes pre-search** when tools are supported (`route.ts:356-367`) — but dual mode itself doesn't pass tools to `streamCompletion` (`route.ts:313-327`), so dual + tool-support just means the final synthesis stream has no tools.
13. **Search decision heuristic-first**: `decideSearch` runs `buildHeuristicDecision` (regex) before any LLM call; `none`/`wiki` heuristic results skip the LLM router entirely (`src/lib/searchDecision.ts:245-247`).
14. **GLM-5.2 `response_format` instability**: `decideSearch` deliberately avoids `response_format: { type: 'json_object' }` (unstable on GLM-5.2, causes empty content/timeouts) — instead parses JSON from a plain completion after stripping markdown fences (`src/lib/searchDecision.ts:221-223, 256-259`).

---

## See also

- [Tool Calling](./tool-calling.md) — built-in tools, MCP integration, connections, tool probe, sanitizer
- [Memory System](./memory.md) — fact/working memory extraction, RAG retrieval, `generateMemories`
- [Skills System](./skills.md) — skill kinds, RAG matching, `generateSkillFromConversation`, `extractSkillCandidates`
- [Hooks & State](./hooks.md) — `useChat`, `useThreads`, `useFolders` state management patterns
- [Architecture Overview](./architecture.md) — high-level system architecture and data flow
- [API Routes Reference](./api-routes.md) — every API endpoint including `POST /api/chat`
- [Database & Schema](./database.md) — `messages`, `threads`, `globalInstructions`, `folders` tables
