---
name: minerva-debug
description: >
  Debugging techniques and troubleshooting guide specific to the MinervaAIWorkspace project.
  Includes known pitfalls and solutions for SSE streaming, Docker builds,
  transformers.js, SQLite (better-sqlite3), and Next.js 16. Refer to this when making code
  changes or debugging MinervaAIWorkspace.
origin: session-debug-log
---

# Skill: MinervaAIWorkspace Debug Guide

Bugs actually encountered during MinervaAIWorkspace development and their solutions. Reduces diagnosis time on recurrence.

## Architecture Overview

```
Next.js 16 (App Router, Turbopack) + Bun
├── src/app/api/         # Route Handlers (SSE streaming, Node.js runtime)
├── src/components/      # React 19 (ChatWindow, Sidebar, Markdown, etc.)
├── src/hooks/           # useChat, useThreads (state management + SSE parsing)
├── src/lib/             # llm.ts (OpenAI SDK), embed.ts (transformers.js)
├── src/db/              # Drizzle ORM + better-sqlite3 (SQLite)
└── Docker               | Bun → Next.js build → runner stage
```
> **DB Migration Notice (2026-07):** MinervaAIWorkspace migrated from PostgreSQL + pgvector
> to SQLite (better-sqlite3). The `docker compose exec db psql` commands in
> sections 8–10 are from the old PostgreSQL era. Use `sqlite3` instead:
> `sqlite3 data/minerva.db "SELECT id, title, model FROM threads;"`
> Section 10 (pgvector cosine distance) no longer applies — embeddings are stored
> as JSON text and queried via application-level cosine similarity.

## Troubleshooting Dictionary

### 1. Thinking content appears in the same place as the message

**Symptom**: The LLM's thinking content is mixed into the answer bubble.

**Cause**: The `MessageBubble` component renders `ThinkingBlock` inside the bubble.

**Fix**: Place `ThinkingBlock` independently outside (above) the bubble.

```tsx
// BAD: ThinkingBlock inside the bubble
<div className="bg-muted ...">
  {thinking && <ThinkingBlock />}
  {answer}
</div>

// GOOD: ThinkingBlock outside the bubble
<div className="flex flex-col items-start gap-1">
  {thinking && <ThinkingBlock />}
  <div className="bg-muted ...">{answer}</div>
</div>
```

**File**: `MessageBubble` in `src/components/ChatWindow.tsx`

---

### 2. Thinking events not reaching the browser (SSE compression issue)

**Symptom**: `event: thinking` arrives with `curl` but not in the browser.

**Diagnosis steps**:
1. Check SSE directly with `curl -sN -X POST localhost:3001/api/chat`
2. Read SSE directly in the browser using `fetch()` (inside `tab.evaluate`)
3. If there's a difference between browser and curl, compression or proxy is the cause

**Cause**: Next.js 16's `compress: true` (default) buffers SSE with gzip.
`thinking` events accumulate in the compression layer and never arrive.

**Fix**: Set `compress: false` in `next.config.ts`.

```typescript
const nextConfig: NextConfig = {
  compress: false, // SSE should not be compressed
};
```

**Documentation**: `node_modules/next/dist/docs/01-app/02-guides/streaming.md`
explicitly states "Gzip and Brotli compression can buffer chunks internally before flushing".

---

### 3. Thinking not arriving (model mismatch issue)

**Symptom**: Thinking doesn't arrive even after disabling compression. It does arrive with curl.

**Diagnosis steps**:
1. Check server logs with `docker compose logs app`
2. Check the `model` column in the `messages` table in the DB
3. Check which model the thread creation API sets

**Cause**: When creating a thread, `body.model` is `undefined`, so the DB default
(`gpt-4o-mini`) is used. `gpt-4o-mini` does not return `reasoning_content`.

**Fix**: Set the default to `defaultModel()` in `src/app/api/threads/route.ts`.

```typescript
model: body.model ?? defaultModel(),
```

**Verify**: `docker compose exec db psql -U umans -d MinervaAIWorkspace -c "SELECT model FROM threads;"`

---

### 4. Code changes not reflected in Docker

**Symptom**: Even after `docker compose up --build -d`, old code persists.

**Cause**: BuildKit's layer cache hits on `COPY . .`.

**Fix**: Full rebuild with `--no-cache`.

```bash
docker compose build --no-cache app
docker compose up -d app --force-recreate
```

---

### 5. Without .dockerignore, node_modules gets overwritten

**Symptom**: `node_modules` fixes in the Dockerfile (e.g., removing symlinks)
disappear at runtime.

**Cause**: Without `.dockerignore`, `COPY . .` overwrites the clean
`node_modules/` inside Docker with the host's `node_modules/`.

**Fix**: Create a `.dockerignore`.

```
node_modules
.next
.git
.env.local
*.md
```

---

### 6. transformers.js crashes with sharp native binary error

**Symptom**: `pipeline()` call from `@xenova/transformers` throws
"Cannot find module '../build/Release/sharp-linux-x64.node'" error.

**Cause**: The `sharp` bundled with `@xenova/transformers` is missing the native binary.

**Fix**: Remove the bundled sharp in the Dockerfile and fall back to the top-level sharp.

```dockerfile
RUN bun install --frozen-lockfile
RUN rm -rf node_modules/@xenova/transformers/node_modules/sharp
```

When used only for text embedding, sharp (image processing) is unnecessary,
but transformers.js attempts to load sharp at startup, so removal is required.

---

### 7. Client-side debugging of SSE events

**Method**: Monkey-patch the browser's `fetch` to intercept SSE.

```javascript
// Run inside tab.evaluate
const origFetch = window.fetch;
window.fetch = async function(...args) {
  const res = await origFetch.apply(this, args);
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  if (url?.includes('/api/chat')) {
    const [a, b] = res.body.tee(); // split the stream
    // observe b, return a to useChat
    (async () => {
      const reader = b.getReader();
      // ...collect events
    })();
    return new Response(a, { status: res.status, headers: res.headers });
  }
  return res;
};
```

**Note**: `res.clone()` can break the stream. Use `tee()`.
Also, the monkey-patch itself can affect event reception, so
finally verify without the patch using `waitForResponse` and `response.text()`.

---

### 8. Checking DB state

```bash
# Check messages and reasoning
docker compose exec -T db psql -U umans -d MinervaAIWorkspace -c \
  "SELECT id, role, LEFT(content, 40), LEFT(reasoning, 40), length(reasoning) FROM messages ORDER BY created_at DESC LIMIT 10;"

# Check embeddings
docker compose exec -T db psql -U umans -d MinervaAIWorkspace -c \
  "SELECT COUNT(*) FROM embeddings;"

# Check thread models
docker compose exec -T db psql -U umans -d MinervaAIWorkspace -c \
  "SELECT id, title, model, current_leaf_id FROM threads;"
```

---

### 9. Direct LLM API testing

```bash
# Call the LLM API directly from inside the container
docker compose exec -T app bun -e '
const OpenAI = (await import("openai")).default;
const llm = new OpenAI({ baseURL: "https://api.code.umans.ai/v1", apiKey: process.env.LLM_API_KEY });
const completion = await llm.chat.completions.create({
  model: process.env.LLM_MODEL,
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const chunk of completion) {
  const delta = chunk.choices?.[0]?.delta;
  const reasoning = delta?.reasoning_content;
  if (reasoning) console.log("REASONING:", reasoning.slice(0, 50));
  if (delta?.content) console.log("CONTENT:", delta.content.slice(0, 50));
}
'
```

---

### 10. [LEGACY — PostgreSQL era] pgvector cosine distance query

> **Stale:** MinervaAIWorkspace now uses SQLite + better-sqlite3. Embeddings are stored as
> JSON text, not pgvector. Cosine similarity is computed at the application level.
> This section is kept for historical reference only.

```sql
-- Similarity search (1 - distance = similarity)
SELECT m.content, m.role, t.title,
       1 - (e.embedding <=> '[0.1, 0.2, ...]'::vector) as similarity
FROM embeddings e
JOIN messages m ON e.message_id = m.id
JOIN threads t ON m.thread_id = t.id
WHERE m.thread_id != 'current-thread-id'
ORDER BY e.embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 5;
```

**Note**: Since drizzle-orm does not directly support pgvector's `<=>` operator,
write raw SQL with the `sql` tag. Pass vectors as `JSON.stringify(array)` and
cast with `::vector`.

---

### 11. Memories not being saved (fire-and-forget issue)

**Symptom**: The `memories` table has 0 rows. The LLM memory extraction call
succeeds, the embedder returns 200 OK, but nothing is saved to the DB. No errors
appear in `docker compose logs app` either (`.catch` is never executed).

**Cause**: In `src/app/api/chat/route.ts`, the `finally` block calls
`generateMemories` as `void generateMemories(...).catch(...)` in a
fire-and-forget manner. When `controller.close()` terminates the stream,
the Next.js production runtime cancels the incomplete background Promise.
The `.catch` handler itself is never executed, so the error is completely silent.

**Fix**: `await generateMemories(...)` inside the `finally` block.
The `done` SSE event is already sent within the `try` block (before `finally`),
so it does not affect client UX. Swallow errors with `try/catch` and log only.

```typescript
// BAD: fire-and-forget — close() cancels the Promise
void generateMemories(...).catch((err) => console.error("[memory]", err));

// GOOD: await guarantees completion (no UX impact since done is already sent)
try {
  await generateMemories(...);
} catch (err) {
  console.error("[memory] generation failed:", err);
}
```

**Note**: Do not move `controller.close()` before the `await`.
Closing the stream first causes the runtime to re-cancel the incomplete Promise.
**File**: `finally` block in `src/app/api/chat/route.ts`.

**Verification**: When the memory extraction LLM call takes a long time (~90s with GLM),
the stream remains open even after `done` is received. The client treats `done`
receipt as completion, so there's no issue, but the server waits for memory
saving to complete.

---

### 12. Vitest test environment DB migration conflict

**Symptom**: `bun run test` throws `SqliteError: no such table: users` or `table 'accounts' already exists`.

**Cause**:
- `vitest.setup.ts` does not run DB migrations (only `drizzle-kit migrate` in `predev`).
- `:memory:` DB throws on `openDatabase`'s `fileMustExist` probe → corruption warning.
- `process.pid`-based DB files are shared across multiple workers, causing migrations to re-run and "table already exists" errors.

**Fix** (`vitest.setup.ts`):
1. Include `VITEST_WORKER_ID` in `DATABASE_URL` to create a unique DB file per worker.
2. Set `DATABASE_URL` at the top of the file (before static import hoisting).
3. Load `@/db` and `migrate` via dynamic `await import()` (to avoid hoisting).
4. Use a `globalThis.__MinervaAIWorkspaceTestDbReady` guard to prevent re-migration within the same worker.
5. Create the shared test user (`test-user-id`) after migration (for FK constraints).

```ts
import { tmpdir } from "node:os";
import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("/app/data/")) {
  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  process.env.DATABASE_URL = join(tmpdir(), `MinervaAIWorkspace-test-${process.pid}-${workerId}.db`);
  try { unlinkSync(process.env.DATABASE_URL); } catch { /* first run */ }
}
// ... load .env ...
const globalForTestSetup = globalThis as unknown as { __MinervaAIWorkspaceTestDbReady?: boolean };
if (!globalForTestSetup.__MinervaAIWorkspaceTestDbReady) {
  const { db } = await import("@/db");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  const { users } = await import("@/db/schema");
  await db.insert(users).values({ id: "test-user-id", nickname: "tester", email: "t@example.com" }).onConflictDoNothing();
  globalForTestSetup.__MinervaAIWorkspaceTestDbReady = true;
}
```

---

### 13. next-auth headers() throws in tests

**Symptom**: `Error: headers was called outside a request scope`

**Cause**: `getSessionUser()` calls `auth()` → `headers()`. In the test environment, there is no Next.js request store.

**Fix**: Add `vi.mock("@/lib/auth-guards")` to the test file.

```ts
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
```

**Note**: Tests that import `chat/route` (e.g., `instruction.test.ts`) also need to mock `after()` from `next/server`.

---

### 14. jsdom does not implement HTMLElement.scrollTo

**Symptom**: `TypeError: el.scrollTo is not a function` (ChatWindow auto-scroll)

**Fix** (`vitest.setup.ts`):
```ts
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function () {};
}
```

---

### 15. I18nProvider initial render is en, causing Japanese assertions to fail

**Symptom**: `getByText("Japanese label")` fails. `I18nProvider`'s `useState(DEFAULT_LOCALE)` initializes with `en`.

**Fix**: Add `vi.mock("@/lib/i18n/types")` to the test file to override `DEFAULT_LOCALE` to `ja`.

```ts
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
```

**Note**:
- `vi.mock` is hoisted, so it is evaluated before component imports.
- Also add `localStorage.setItem("MinervaAIWorkspace-locale", "ja")` in `beforeEach` (for useEffect restore consistency).
- Hook tests (`.ts` files) need an `I18nProvider` wrapper. Since JSX is unavailable, use `createElement`:
```ts
import { createElement, type ReactNode } from "react";
import { I18nProvider } from "@/components/I18nProvider";
const wrapper = ({ children }: { children: ReactNode }) => createElement(I18nProvider, null, children);
// alias renderHook to auto-apply the wrapper
import { renderHook as rtlRenderHook } from "@testing-library/react";
function renderHook<T>(callback: () => T) {
  return rtlRenderHook(callback, { wrapper });
}
```

---

### 16. Accordion component testing (AnimatePresence exit animation)

**Symptom**: `queryByPlaceholderText(...).not.toBeInTheDocument()` fails after toggle click. The element remains in the DOM during `AnimatePresence` exit animation.

**Fix**: Use `await waitFor()` to wait for exit completion.
```ts
fireEvent.click(btn); // close
await waitFor(() => {
  expect(screen.queryByPlaceholderText("...")).not.toBeInTheDocument();
});
```

**Note**: `Accordion` mounts with `defaultOpen=false`. To inspect its contents, you must click to open it. `closest("details")` cannot be used (`Accordion` uses `<button>` + `AnimatePresence`, not `<details>`).

---

### 17. Route Handler test with Japanese status message mismatch

**Symptom**: `expect(lastStatus.data.label).toContain("No results found in web search")` fails. The actual value is in English.

**Cause**: `getRequestLocale(req)` falls back to `DEFAULT_LOCALE = "en"` without a cookie.

**Fix**: Add a locale cookie to the test's Request helper:
```ts
headers: { "Content-Type": "application/json", cookie: "MinervaAIWorkspace-locale=ja" },
```

---

### 18. useFolders error not cleared after success

**Symptom**: After a create/update/remove failure followed by success, `error` does not become `null`.

**Cause**: `useFolders`'s `create`/`update`/`remove` do not call `setError(null)` on success (`useThreads.move` does).

**Fix**: Add `setError(null)` to the success path.

---

### 19. folder.instruction not merged into chat route

**Symptom**: `instruction.test.ts` returns 404 or the systemContent does not include the folder instruction.

**Cause**: `chat/route.ts` was not reading the `instruction` column from the `folders` table.

**Fix**: In `chat/route.ts`, look up `folders.instruction` via `thread.folderId` (ownership check via `folders.userId === user.id`). Trim-only whitespace is excluded. Prepend to `systemContent`.

---

### 20. GLM tool loops + fabricated file structure (agent tooling)

**Symptom**: GLM-5.2 with tools enabled repeatedly calls `list_directory` on slightly different paths (`src/`, `src/components/`, …), says it “couldn’t see it well”, then fabricates paths/fields that were never in tool results. Same model on Oh My Pi / coding agents looks much smarter.

**Causes (stack, not just “model is dumb”)**:
1. **Tool rounds forced thinking off** — historically `streamCompletion` applied `disableReasoningParams` whenever `useToolsThisRound` was true. GLM then explores without planning.
2. **Only shallow list + read** — no first-class glob/grep tools; models invent directory trees via repeated one-level lists.
3. **Exact-signature loop detection** — different path args never hit dedup.
4. **Prompt rules alone** — models ignore long TOOL USE RULES when results are empty/ambiguous.

**Fix (implemented)**:
1. Keep `reasoning_effort` during tool rounds; only disable thinking when effort is explicitly `"none"`.
2. Prefer `search_files` (glob) and `grep_content` (regex) for exploration; `list_directory` supports `depth` (1–6). Empty results are tagged `[SEARCH empty]` / `[GREP empty]` / `[LIST empty]`.
3. Tool guard rule 10 tells the model to use search/grep instead of list chains / sandbox.

**Files**: `src/app/api/chat/route.ts` (`streamCompletion`, `STREAM_TOOLS`), `src/lib/workspace.ts`.

**Still not fixed by code alone**: multi-turn history still drops tool transcripts; models can still ignore results. Prefer better exploration tools + thinking over more system-prompt rules.

---

### 21. Tool-round narration leaks into the user answer (false “I confirmed”)

**Symptom**: Model streams “確認した / StoryPart.text は…” *before* tool results, and that text stays in the bubble / DB answer even when tools later contradict it. Looks like high hallucination; same GLM elsewhere is fine.

**Cause**: `streamCompletion` called `onDelta` for every content chunk, including completions that also emit `tool_calls`. History stores those assistant turns as `content: null` + `tool_calls`, so only the **user** kept the lie; the model never “owned” it on the next round. Final prose was then **appended** on top of the intermediate text in `assistantContent`.

**Fix**:
1. When tools are offered, buffer content until the stream ends (`toolStreamPolicy.resolveBufferedToolRoundContent`).
2. If the round had `tool_calls`, discard the buffer (log `discarded-tool-round-content`).
3. If no tool_calls, flush the buffer as the user-visible answer.
4. After tool results, inject `TOOL_GROUNDING_REMINDER` system message.

**Files**: `src/lib/toolStreamPolicy.ts`, `src/app/api/chat/route.ts` (`streamCompletion`).

---

### 22. Thinking-only end after tools (no user-visible answer)

**Symptom**: Long `thinking` stream, tools may have run, then `done` with empty assistant bubble. User says “thinking で終わった”. Common on GLM with high reasoning after tool-round content buffering.

**Cause**: Model puts the entire plan/summary in `reasoning_content` and emits zero `content`. Discarding tool-round prose is correct, but without a recovery turn the UI stays empty.

**Fix**: After the main tool loop, if `emittedContentChars === 0`, inject `FINAL_ANSWER_REQUIRED_REMINDER` and run one **tools-off** stream (`force-final-answer` log). Status: `chat.statusFinalAnswerRequired`. Also raised `MAX_TOOL_ROUNDS` to 12 for multi-step agent work (explore → script → kb_ingest → verify).

**Files**: `toolStreamPolicy.ts`, `streamCompletion` tail in `route.ts`.

---

### 23. Multi-doc RAG jobs die mid-thinking (N× kb_ingest)

**Symptom**: Agent plans many single `kb_ingest` calls, then ends mid-thinking with incomplete work.

**Causes**:
1. One `kb_ingest` per document burns `MAX_TOOL_ROUNDS` and thinking budget.
2. LLM HTTP timeout default was 120s — high-thinking streams can exceed it.
3. Even with force-final-answer, the model may only *describe* remaining work.

**Fix**:
1. Prefer **`kb_from_jsonl`** / **`kb_ingest_jsonl`**: one JSONL (line = doc), one bulk call.
2. Transform proprietary formats via **sandbox** → JSONL, then bulk ingest — do **not** ship domain-specific builders in core agent tools.
3. Sandbox: read `/workspace`, write `/out` + `outputFiles`.
4. `LLM_TIMEOUT_MS` default **300000** (5 min).

**Product rule**: Core tools stay schema-agnostic (`kb_*`, workspace, sandbox). User-specific data shapes belong in workspace scripts/JSONL, not in STREAM_TOOLS.

**Files**: `kbStore.ts`, STREAM_TOOLS in `route.ts`.

---

### 26. Bulk KB ingest floods /embed and chat "ends" with no reply

**Symptom**: Chat goes silent; docker embedder logs endless `POST /embed 200`; stream never finishes a user-visible answer.

**Cause**: `ingestJsonlFile` called `ingestDocument` per line → one HTTP `/embed` per document (thousands of sequential requests) while the chat SSE waited on the tool. Client often times out; server keeps embedding.

**Fix**: Parse → chunk all → batched `embedTexts` (HTTP batch + progress slices) → write docs/chunks. SSE status `statusToolKbEmbedProgress` / `statusToolKbWriteProgress`. Log `jsonl-batch-embed-start/done`.

---

### 27. Knowledge bases ON but never used / kb_search `near "?"`

**Symptom**: Thread has active KB checked; chat still ignores RAG. Agent `kb_search` fails with `near "?": syntax error` (or Japanese queries look broken). Model falls back to "記憶にない".

**Cause**: `searchKnowledgeBases` built `IN ${sql.join(...)}` **without parentheses** → SQL like `IN ?` / `IN ?, ?`. SQLite rejects that. Auto-inject (`buildKnowledgeContextMessage`) caught the error and returned null; tool path returned the error string to the model.

**Fix**: `IN (${sql.join(kbIds.map(id => sql\`${id}\`), sql\`, \`)})`. Cover with a search test (single + multi id).

**Files**: `src/lib/kbStore.ts` (`searchKnowledgeBases`).

---

### 29. Agent cannot create subset KB (read_file on multi-MB JSONL)

**Symptom**: User wants a filtered/themed KB. Agent `read_file`s large JSONL, hits size limit, no KB created.

**Cause**: No first-class “create KB from filtered JSONL” tool.

**Fix**: `kb_from_jsonl` + `JsonlLineFilter` (`filter_equals` / `filter_contains` / `filter_any_*` / `filter_json`). Do not `read_file` multi-MB JSONL.

**Examples**:
- `kb_from_jsonl` name=`work-q3` path=`docs/notes.jsonl` filter_contains=`tag=work`
- `kb_from_jsonl` name=`alice-notes` path=`export.jsonl` filter_contains=`name=Alice`

**Files**: `jsonlFilter.ts`, `kbStore.createKnowledgeBaseFromJsonl`, STREAM_TOOLS `kb_from_jsonl`.

---

### 28. KB RAG wrong entity attribution (vector-only precision)

**Symptom**: Question names person/project A; answer quotes chunks about B. Search "works" but precision is bad.

**Cause**: Pure cosine matches topical verbs/phrases over the named entity. Model attributes top hit without checking title label.

**Fix** (hybrid):
1. Vector recall (wider) + keyword LIKE + re-rank with title-prefix / subject boost (`kbSearchRank.ts`).
2. Auto-inject prompt: attribute only to title speaker/label (prefix before `|`).
3. Stamp multi-chunk docs with title when missing (`prefixChunkWithTitle`).

**Files**: `src/lib/kbSearchRank.ts`, `src/lib/kbStore.ts`.

---

### 25. KB documentCount always 0

**Symptom**: KB list badge shows `0` documents though expand shows docs.

**Cause**: `listKnowledgeBases` correlated COUNT used drizzle column objects inside the subquery → wrong SQL, count always 0.

**Fix**: COUNT with raw `kb_documents.knowledge_base_id = knowledge_bases.id` + `mapWith(Number)`. Prefer many focused JSONL docs over one giant blob for retrieval quality. `ingestJsonlFile` default max lines 10k (cap 20k).

---

### 30. Do not ship personal domain tools in public core

**Rule**: MinervaAIWorkspace is public. Agent tools and `src/lib` product APIs must stay **schema-agnostic** (JSONL fields, workspace files, sandbox). Do not add STREAM_TOOLS or core libs that encode one user's game/data format (e.g. Character/Message/HomeTalk one-shot builders). Domain transforms live in the user's workspace (scripts + JSONL) or optional external plugins — not in the shared app.

---

### 31. Agent feels dumber than OMP — loop exits on first no-tool completion

**Symptom**: Multi-step work (filter JSONL → kb_from_jsonl) ends mid-plan with thinking-only or a tiny body; tools never finish. Same model in OMP keeps going until done.

**Cause (architecture, not “model IQ”)**:
1. `streamCompletion` **broke the tool loop** when a round had `hadToolCalls=false`, even if content was empty (thinking-only stop).
2. Tool-round prose is buffered/discarded (correct for false narration) → no intermediate “comments” like OMP.
3. Post-hooks only force a **final report** (tools **off**), not another work round with tools **on**.
4. Hard `MAX_TOOL_ROUNDS` (12) and duplicate-call breaker exist, but the main gap was **premature exit**, not the cap.

**Fix**: `agentContinuePolicy` — if tools were offered, no tool_calls, and no real user-visible answer (or tiny body after tools), re-inject CONTINUE system prompt and **keep tools on** up to `AGENT_CONTINUE_RETRIES` (default 3). Status: `statusAgentContinue`.

**Not the same as OMP yet**: still single HTTP turn, no durable multi-session agent, intermediate content still discarded during tool rounds.

**Files**: `src/lib/agentContinuePolicy.ts`, `streamCompletion` in `route.ts`.

---



### 24. Agent hooks: always report in message body (OMP-style)

**Symptom**: Tools ran (KB created, JSONL written) but the user only sees thinking — no usable body.

**Fix (server hooks in `src/lib/agentHooks.ts`)**:
1. Record every tool result in a transcript.
2. If user-visible content is still empty/tiny after the main loop → force one tools-off LLM report with tool results embedded in the system prompt.
3. If still empty → **deterministic auto-report** in content listing tool names + snippets (ja/en). Never leave an empty bubble.

Logs: `hook-force-final-answer`, `hook-auto-user-report`.

---

### 32. Docker / `next build` fails on `@cursor/sdk` `*.js.LICENSE.txt`

**Symptom**: `npx next build` (Docker `app` stage) fails with:

```
./node_modules/@cursor/sdk/dist/esm/250.js.LICENSE.txt
Unknown module type
This module doesn't have an associated type.
```

**Cause**: `@cursor/sdk` ships webpack-bundled ESM chunks whose header comments reference sibling `*.js.LICENSE.txt` files. Turbopack follows those as modules and has no loader for `.txt`.

**Fix**: Externalize the package so Next does not bundle it:

```typescript
serverExternalPackages: ["better-sqlite3", "sqlite-vec", "@cursor/sdk"],
```

Also add SDK (+ platform optional packages) to `outputFileTracingIncludes` for standalone.

**File**: `next.config.ts`

---

## Basic Debugging Steps

1. **Reproduce the symptom** — reliably reproduce via browser or curl
2. **Check server logs** — `docker compose logs app --tail=30`
3. **Check DB state** — use psql to verify data presence and integrity
4. **Direct API test** — call the API directly via curl or `bun -e` inside the container
5. **Check browser DOM** — inspect DOM structure and styles via `tab.evaluate`
6. **Compare differences** — identify differences between curl vs browser, working env vs broken env
7. **Minimal reproduction** — find the minimal conditions to reproduce the issue

## Frequently Used Files

| File | Role |
|---|---|
| `src/app/api/chat/route.ts` | SSE streaming, LLM calls, RAG, embedding |
| `src/hooks/useChat.ts` | Client-side SSE parsing, state management, branching |
| `src/components/ChatWindow.tsx` | Message display, input, regenerate/edit |
| `src/lib/llm.ts` | LLM client, model settings |
| `src/lib/embed.ts` | transformers.js embedding |
| `next.config.ts` | compress setting, Next.js config |
| `Dockerfile` | Build stages, sharp removal |
| `.dockerignore` | Prevents node_modules overwrite |
| `docker-compose.yml` | Env vars, port mapping |
| `src/lib/i18n/types.ts` | DEFAULT_LOCALE, LOCALE_STORAGE_KEY |
| `src/lib/auth-guards.ts` | getSessionUser (next-auth headers) |
| `src/hooks/useFolders.ts` | Folder CRUD, error clearing |
| `src/components/ui/motion.tsx` | Accordion, AnimatePresence |
| `vitest.setup.ts` | DB migration, test user, scrollTo polyfill |
| `vitest.config.mts` | threads pool, next/server alias |

## Environment Variables

```
DATABASE_URL=minerva.db
LLM_API_KEY=sk-...
LLM_MODEL=umans-glm-5.2
```
