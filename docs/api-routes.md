Complete reference for every API route in UmansChat — methods, paths, request/response shapes, and key behaviors.

## Relevant source files

All routes live under `src/app/api/`. Each route file exports `runtime` and `dynamic`:

| Directory | Route file(s) |
|-----------|---------------|
| `src/app/api/threads/` | `route.ts`, `[id]/route.ts` |
| `src/app/api/folders/` | `route.ts`, `[id]/route.ts` |
| `src/app/api/chat/` | `route.ts` |
| `src/app/api/search/` | `route.ts` |
| `src/app/api/scrape/` | `route.ts` |
| `src/app/api/upload/` | `route.ts` |
| `src/app/api/models/` | `route.ts` |
| `src/app/api/settings/` | `route.ts` |
| `src/app/api/memories/` | `route.ts`, `[id]/route.ts` |
| `src/app/api/skills/` | `route.ts`, `[id]/route.ts` |
| `src/app/api/skill-candidates/` | `route.ts`, `[id]/route.ts` |
| `src/app/api/mcp-servers/` | `route.ts`, `[id]/route.ts` |
| `src/app/api/connections/` | `route.ts`, `notion/authorize/route.ts`, `notion/callback/route.ts` |
| `src/app/api/tunnel/` | `route.ts` |
| `src/app/api/tor/` | `route.ts` |
| `src/app/api/global-instructions/` | `route.ts`, `[id]/route.ts` |
| `src/app/api/auth/` | `[...nextauth]/route.ts` |
| `src/lib/auth-guards.ts` | `getSessionUser()` helper |
| `src/db/index.ts` | Drizzle `db` instance |
| `src/db/schema.ts` | Table schemas |

## Common patterns

Every API route in UmansChat follows these conventions:

### Runtime and caching

```typescript
export const runtime = "nodejs";      // Node.js runtime (not Edge)
export const dynamic = "force-dynamic"; // Never cached, always re-rendered
```

### Authentication

All routes require an authenticated session. Authentication is checked via `getSessionUser()` from `src/lib/auth-guards.ts`:

```typescript
const user = await getSessionUser();
if (!user) return new Response("Unauthorized", { status: 401 });
```

See [Authentication & User Isolation](./authentication.md) for details on the auth flow.

### Per-user scoping

All data queries are scoped to the authenticated user via `userId`. No route exposes or allows access to another user's data. Typical pattern:

```typescript
// Direct: table has userId column
.where(eq(threads.userId, user.id))

// Indirect: scope through a parent table
// (e.g. memories have no userId; scope via threadId → threads.userId)
.innerJoin(threads, eq(memories.threadId, threads.id))
.where(eq(threads.userId, user.id))
```

### Response conventions

| Pattern | Example |
|---------|---------|
| Success (list) | `Response.json(rows)` — 200 |
| Success (create) | `Response.json(row, { status: 201 })` |
| Success (delete) | `new Response(null, { status: 204 })` |
| Unauthorized | `new Response("Unauthorized", { status: 401 })` |
| Not found | `new Response("Not found", { status: 404 })` |
| Bad request | `new Response("field is required", { status: 400 })` |
| Conflict | `new Response("already exists", { status: 409 })` |

### JSON body parsing

Most POST/PATCH routes parse JSON bodies with try/catch fallback:

```typescript
let body: BodyType = {};
try {
  body = (await req.json()) as BodyType;
} catch {
  return new Response("Invalid JSON", { status: 400 });
}
```

---

## Threads

Thread CRUD. Threads are the primary conversation container. See [Database & Schema](./database.md) for the `threads` table.

### `GET /api/threads` — List threads

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | `Thread[]` (metadata only, newest first) |

Returns the authenticated user's threads ordered by `updatedAt DESC`. Selects metadata columns only (no message body). The select includes: `id`, `title`, `model`, `folderId`, `responseMode`, `dualModelA`, `dualModelB`, `dualStrategy`, `dualDebateRounds`, `mcpServerIds`, `connectionIds`, `globalInstructionId`, `currentLeafId`, `systemPrompt`, `createdAt`, `updatedAt`.

**Response shape:**

```typescript
[
  {
    id: string;
    title: string;
    model: string;
    folderId: string | null;
    responseMode: "single" | "dual";
    dualModelA: string | null;
    dualModelB: string | null;
    dualStrategy: "cross_review" | "debate";
    dualDebateRounds: number;
    mcpServerIds: string[] | null;
    connectionIds: string[] | null;
    globalInstructionId: string | null;
    currentLeafId: string | null;
    systemPrompt: string | null;
    createdAt: string;
    updatedAt: string;
  }
]
```

### `POST /api/threads` — Create thread

| Property | Value |
|----------|-------|
| Auth | Required |
| Content-Type | `application/json` (optional — empty body creates defaults) |
| Body | `CreateBody` (all fields optional) |
| Response | `Thread` (201) |

Creates a new thread. All body fields are optional — a bare POST creates a thread with defaults.

**Request body:**

```typescript
{
  title?: string;              // default: "New chat"
  systemPrompt?: string;
  model?: string;             // default: defaultModel() (LLM_MODEL env)
  folderId?: string | null;
  responseMode?: "single" | "dual";  // default: "single"
  dualModelA?: string | null;
  dualModelB?: string | null;
  dualStrategy?: "cross_review" | "debate";  // default: "cross_review"
  dualDebateRounds?: number;  // clamped to 1–5, default: 2
  globalInstructionId?: string | null;
}
```

**Behavior:**
- `dualDebateRounds` is clamped to 1–5 via `clampDebateRounds()`.
- `responseMode` accepts only `"single"` or `"dual"`; invalid values default to `"single"`.
- `dualStrategy` accepts only `"cross_review"` or `"debate"`; invalid values default to `"cross_review"`.

### `PATCH /api/threads?id=...` — Update thread

| Property | Value |
|----------|-------|
| Auth | Required |
| Query | `id` (required) |
| Body | `PatchBody` (partial) |
| Response | `Thread` (200) or 404 |

Updates a thread by `id` query parameter. Only specified fields are applied. `updatedAt` is always set.

**Request body:**

```typescript
{
  title?: string;
  systemPrompt?: string | null;
  model?: string;
  folderId?: string | null;
  responseMode?: "single" | "dual";
  dualModelA?: string | null;
  dualModelB?: string | null;
  dualStrategy?: "cross_review" | "debate";
  dualDebateRounds?: number;
  mcpServerIds?: string[];
  connectionIds?: string[];
  globalInstructionId?: string | null;
  currentLeafId?: string | null;  // branch pointer (see Chat & Streaming)
}
```

**Behavior:**
- `dualModelA`/`dualModelB`/`globalInstructionId` accept empty string → normalized to `null`.
- `dualDebateRounds` is clamped to 1–5.
- Returns 404 if thread not found or not owned by user.

### `GET /api/threads/[id]` — Get thread detail

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Response | `{ thread, messages, attachments }` (200) or 404 |

Returns the full thread with all messages (including branching info) and linked attachments.

**Response shape:**

```typescript
{
  thread: Thread;
  messages: Array<{
    id: string;
    threadId: string;
    parentId: string | null;  // for branch traversal
    role: "user" | "assistant" | "system";
    content: string;
    reasoning: string | null;
    metadata: object | null;
    createdAt: string;
  }>;
  attachments: Array<{
    id: string;
    messageId: string | null;  // null until linked at send time
    filename: string;
    mimeType: string;
    dataUrl: string | null;    // base64 for images
  }>;
}
```

Messages are ordered by `createdAt ASC, id ASC`. The client traverses `parentId` chains to display branches.

### `DELETE /api/threads/[id]` — Delete thread

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Response | 204 (no content) or 404 |

Deletes a thread. Messages are removed via cascading delete.

---

## Folders

Folders group threads and carry an instruction and memory scope setting.

### `GET /api/folders` — List folders

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | `Folder[]` (newest first) |

Returns all columns from the `folders` table for the user, ordered by `updatedAt DESC`.

**Response shape:**

```typescript
[
  {
    id: string;
    name: string;
    instruction: string | null;
    memoryScope: "folder" | "global";
    userId: string;
    createdAt: string;
    updatedAt: string;
  }
]
```

### `POST /api/folders` — Create folder

| Property | Value |
|----------|-------|
| Auth | Required |
| Content-Type | `application/json` (optional — empty body creates defaults) |
| Body | `FolderBody` (all fields optional) |
| Response | `Folder` (201) |

**Request body:**

```typescript
{
  name?: string;              // default: "New folder"
  instruction?: string | null;  // default: null
  memoryScope?: "folder" | "global";  // default: "global"
}
```

**Behavior:**
- Invalid `memoryScope` falls back to `"global"`.
- `instruction` is trimmed; empty string becomes `null`.

### `PATCH /api/folders?id=...` — Update folder

| Property | Value |
|----------|-------|
| Auth | Required |
| Query | `id` (required) |
| Body | `PatchBody` (partial) |
| Response | `Folder` (200) or 404 |

**Request body:**

```typescript
{
  name?: string;              // blank → "New folder"
  instruction?: string | null;
  memoryScope?: "folder" | "global";  // invalid → 400
}
```

**Behavior:**
- Blank `name` is normalized to `"New folder"`.
- Invalid `memoryScope` returns 400 (unlike POST, which falls back to default).
- `instruction` accepts `null` to clear; empty string becomes `null`.

### `DELETE /api/folders/[id]` — Delete folder

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Response | 204 (no content) or 404 |

Deletes a folder. Associated threads' `folderId` is set to `null` via `ON DELETE SET NULL`. Messages and memories are preserved.

---

## Chat

### `POST /api/chat` — SSE streaming chat

| Property | Value |
|----------|-------|
| Auth | Required |
| Content-Type | `application/json` |
| Response | `text/event-stream` (SSE) |

The core chat endpoint. Streams assistant responses via Server-Sent Events with branching, tool calling, search, memory, and dual-model support.

**Request body:**

```typescript
{
  threadId: string;           // required
  content?: string;           // user message (required for "send"/"edit" modes)
  systemPrompt?: string;      // fallback if no thread/user instruction
  model?: string;             // override thread model
  mode?: "send" | "regenerate" | "edit";  // default: "send"
  parentMessageId?: string;   // required for "regenerate" and "edit"
  rapid?: boolean;            // skip tools/search/memory for instant response
  timeRange?: "day" | "week" | "month" | "year";  // search time filter
}
```

**SSE events:**

| Event | Data | Description |
|-------|------|-------------|
| `start` | `{ userMessageId }` | Stream opened, user message saved |
| `status` | `{ label }` | Status label (e.g. "searching...") |
| `delta` | `{ delta }` | Content token stream |
| `thinking` | `{ delta }` | Reasoning token stream |
| `dual_trace` | `{ dualTrace }` | Dual-model trace (cross_review/debate) |
| `sources` | `SourceInfo[]` | Web search sources |
| `replace_content` | `{ content }` | Replace displayed content (sanitization) |
| `tool_call` | `{ name, args }` | MCP/connection tool call started |
| `tool_result` | `{ name, result }` | MCP/connection tool call result |
| `done` | `{ assistantMessageId, model, elapsedMs }` | Stream complete |
| `error` | `{ message }` | Error during stream |

**Key behaviors:**
- **Branching:** `mode="edit"` creates a new branch from `parentMessageId`; `mode="regenerate"` re-runs from `parentMessageId` without saving a new user message. See [Chat & Streaming](./chat-streaming.md).
- **System prompt resolution priority:** thread-specific `systemPrompt` > global instruction (thread override > user default) > `body.systemPrompt`. Folder instructions are prepended if present.
- **Rapid mode:** Skips search, URL scraping, memory, skills, tool probe, MCP, and connections for immediate response.
- **Dual mode:** When `thread.responseMode === "dual"`, runs two models (cross_review or debate strategy) before synthesis.
- **Tool calling:** If the model supports tools (via `probeToolSupport`), autonomous search/scrape and MCP/connection tools are available during streaming.
- **Post-stream:** After the SSE stream closes, memory generation and skill candidate extraction run in the background via Next.js `after()`.
- **Auto-title:** If thread title is `"New chat"` and history is empty, the first user message (truncated to 40 chars) becomes the title.

> **Full details:** See [Chat & Streaming](./chat-streaming.md) for the complete SSE protocol, branching model, dual-model flow, and rapid mode.

---

## Search & Scrape

### `POST /api/search` — Semantic search

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | `{ query: string; threadId?: string }` |
| Response | `{ results: MemorySearchResult[]; pages: PageSearchResult[] }` |

Embeds the query and searches both memories and page embeddings using cosine similarity (app-side).

**Request body:**

```typescript
{
  query: string;      // required
  threadId?: string;  // current thread (excluded from memory results)
}
```

**Response shape:**

```typescript
{
  results: Array<{           // memory matches (max 10)
    memoryId: string;
    threadId: string;
    threadTitle: string;
    kind: string;
    content: string;
    similarity: number;      // > 0.3 threshold
  }>;
  pages: Array<{             // page matches (max 5)
    pageId: string;
    url: string;
    title: string;
    contentPreview: string;
    similarity: number;      // > 0.3 threshold
  }>;
}
```

**Behavior:**
- Empty/whitespace query returns `{ results: [], pages: [] }`.
- Embedding failure (empty vector) returns `{ results: [], pages: [] }`.
- Results are sorted by similarity DESC, filtered by > 0.3 threshold.
- Memory search joins `memories` with `threads` for `threadTitle`; excludes the current `threadId`.

### `POST /api/scrape` — Scrape URL

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | `{ url: string }` |
| Response | Scrape result (200) or error (400/502) |

Scrapes a web page via the scraper microservice and stores it as a knowledge page with embeddings.

**Request body:**

```typescript
{ url: string }  // required
```

**Response shape (success):**

```typescript
{
  id: string;
  url: string;
  title: string;
  contentPreview?: string;  // first 200 chars (omitted on cache hit)
  cached: boolean;           // true if served from cache
  stale?: boolean;           // true if stale content kept on fetch failure
}
```

**Behavior:**
1. URL normalization + validation via `normalizeUrl()`.
2. Cache check: looks up existing page by `urlHash`.
3. If content hash matches existing page → cache hit (no re-scrape, no re-embed).
4. If fetch fails but existing page exists → returns stale content (`cached: true, stale: true`).
5. On success: upserts page via `upsertPage()` and regenerates `page_embeddings` (cached by `contentHash`).
6. Fetch failure with no existing page → 502 with error message.

---

## Upload & Models

### `POST /api/upload` — File upload

| Property | Value |
|----------|-------|
| Auth | Required |
| Content-Type | `multipart/form-data` |
| Max size | 10 MB (`MAX_FILE_SIZE`) |
| Response | Upload result (201) or error (400/404/413/415/422) |

Uploads a file attached to a thread. Files are stored in the `attachments` table.

**Form data:**

```typescript
{
  threadId: string;  // required
  file: File;         // required (image/PDF/text)
}
```

**Processing by type:**

| MIME type | Processing |
|-----------|------------|
| `image/*` | Converted to base64 dataURL, stored in `dataUrl` |
| `application/pdf` | Text extracted via `pdf-parse` → `extractedText` |
| `text/*`, `application/json`, `application/xml` | Read as UTF-8 → `extractedText` |
| `.md`, `.txt`, `.json`, `.csv`, `.xml`, `.yml`, `.yaml`, `.ts`, `.js`, `.py` | Read as UTF-8 → `extractedText` |
| Other | 415 Unsupported Media Type |

**Response shape:**

```typescript
{
  id: string;
  filename: string;
  mimeType: string;
  hasImage: boolean;              // true if image (dataUrl stored)
  hasText: boolean;              // true if text extracted
  extractedTextPreview: string | null;  // first 200 chars
}
```

**Behavior:**
- `messageId` is `null` at upload time; linked when the message is sent in chat.
- Thread ownership is verified (404 if thread not found or not owned).
- PDF parse failure → 422.

### `GET /api/models` — Available models

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | `{ models, default, displayNames }` (200) |

Returns the list of available LLM models.

**Response shape:**

```typescript
{
  models: string[];          // model IDs
  default: string;           // default model ID
  displayNames: Record<string, string> | {};  // model → display name
}
```

**Behavior:**
- **Umans mode:** Fetches model list + display names from `/v1/models/info`.
- **OAI-compatible mode:** Built from `LLM_MODELS` env (comma-separated); `displayNames` is empty.

---

## Settings

### `GET /api/settings` — Get all settings

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | Settings object (200) |

Returns all current settings from `.env` + per-user DB settings. Secrets are never returned in plaintext — only a boolean `has*` flag indicates whether they are set.

**Response shape (selected fields):**

```typescript
{
  // LLM
  llmBaseUrl: string;
  llmApiKey: string;        // always "" (never returned)
  hasLlmApiKey: boolean;
  llmModel: string;
  llmModels: string;
  thinkingEffort: string;
  // Embeddings
  embedModel: string;
  embedDim: number;
  embedProvider: string;
  embedModelOptions: Array<{ value, label, provider, dim }>;
  dbVectorDim: number;          // current DB vector dimension
  dbPageEmbeddingsDim: number;
  // Web search
  webSearchModel: string;
  webSearchMaxResults: number;
  webSearchMaxRounds: number;
  scraperUrl: string;
  searxngUrl: string;
  // Tor proxy
  torProxy: string;
  scrapeProxy: string;
  // Database / runtime
  databaseUrl: string;
  hostOs: string;
  tz: string;
  // Notion OAuth
  notionClientId: string;
  notionClientSecret: string;  // always ""
  hasNotionClientSecret: boolean;
  authUrl: string;
  // Cloudflare Tunnel
  tunnelToken: string;          // always ""
  hasTunnelToken: boolean;
  // Per-user (DB)
  activeInstructionId: string | null;
  personalStyle: string | null;
  personalWarmth: number;
  personalEnergy: number;
  personalStructure: number;
  personalEmoji: number;
}
```

### `POST /api/settings` — Save settings

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | `SettingsBody` (partial) |
| Response | `{ success, migrationApplied, message }` (200) or 409/400/500 |

Saves settings to `.env` (persisted) and `process.env` (immediate). Per-user fields (`activeInstructionId`, personalization) are saved to the `users` table.

**Request body (all optional):**

```typescript
{
  // LLM
  llmBaseUrl?: string;
  llmApiKey?: string;            // undefined = preserve existing
  llmModel?: string;
  llmModels?: string;
  thinkingEffort?: string;
  // Embeddings
  embedModel?: string;
  embedDim?: number;              // 1–4096
  embedProvider?: string;
  // Web search
  webSearchModel?: string;
  webSearchMaxResults?: number;  // 1–20
  webSearchMaxRounds?: number;   // 1–5
  scraperUrl?: string;
  searxngUrl?: string;
  // Tor proxy
  torProxy?: string;
  scrapeProxy?: string;
  // Database / runtime
  databaseUrl?: string;
  hostOs?: string;
  tz?: string;
  // Notion OAuth
  notionClientId?: string;
  notionClientSecret?: string;
  authUrl?: string;
  // Cloudflare Tunnel
  tunnelToken?: string;          // empty string = preserve existing
  // Per-user (DB)
  activeInstructionId?: string | null;
  personalStyle?: string | null;
  personalWarmth?: number;        // 0–2 (clamped)
  personalEnergy?: number;        // 0–2 (clamped)
  personalStructure?: number;    // 0–2 (clamped)
  personalEmoji?: number;         // 0–2 (clamped)
  // Migration
  applyMigration?: boolean;
}
```

**Response shape:**

```typescript
{
  success: true;
  migrationApplied: boolean;
  message: string;
}
```

**Key behaviors:**
- **Embedding migration:** If `embedDim` changes and `applyMigration !== true`, returns 409 with `{ error: "migration_required", currentDim, newDim }`. With `applyMigration: true`, all `memories` and `page_embeddings` are deleted (incompatible vector spaces), and all `skills` are re-embedded with the new model.
- **Secret preservation:** `llmApiKey` and `tunnelToken` are only written when non-empty (empty string preserves the existing value).
- **Cache invalidation:** LLM setting changes invalidate `resetUmansModelsCache()` and `resetToolProbeCache()`. Embedding changes invalidate `resetEmbedPipeline()`.
- **Scraper live-update:** If `SCRAPE_PROXY` or `SCRAPE_TIMEOUT` change, a POST is sent to the scraper's `/config` endpoint for immediate effect.
- **Validation:** `webSearchModel` must be alphanumeric (`/^[a-zA-Z0-9._-]+$/`); `thinkingEffort` must be alphanumeric; `personalStyle` must be a valid preset or `null`.

> **Full details:** See [Settings & Environment](./settings-env.md) for all `.env` variables and cache invalidation behavior.

---

## Memories

Memory CRUD. Memories have no `userId` column — ownership is scoped via `threadId → threads.userId`. See [Memory System](./memory.md).

### `GET /api/memories` — List memories

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | `Memory[]` (newest first) |

Returns the user's non-suppressed memories (soft-deleted excluded via `suppressedAt IS NULL`). Excludes the `embedding` column. Joins with `threads` for `threadTitle`.

**Response shape:**

```typescript
[
  {
    id: string;
    threadId: string;
    threadTitle: string;
    folderId: string | null;
    kind: "fact" | "working";
    content: string;
    importance: number;  // 0–1
    createdAt: string;
    updatedAt: string;
  }
]
```

### `POST /api/memories` — Create memory

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | `CreateBody` |
| Response | `Memory` (201) or 400/404/503 |

Manually creates a memory. Generates embedding + content hash.

**Request body:**

```typescript
{
  content: string;      // required
  kind?: "fact" | "working";  // default: "fact"
  importance?: number;        // 0–1, clamped, default: 0.5
  threadId: string;     // required (ownership verified)
}
```

**Behavior:**
- Verifies thread ownership (400 if thread not found or not owned).
- No duplicate check — manual additions allow identical content in different contexts.
- `importance` is clamped to `[0, 1]`.
- Embedding failure → 503.

### `PATCH /api/memories/[id]` — Update memory

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Body | `PatchBody` (partial) |
| Response | `Memory` (200) or 404 |

**Request body:**

```typescript
{
  content?: string;    // non-empty, triggers re-embedding
  kind?: "fact" | "working";
  importance?: number;  // 0–1, clamped
}
```

**Behavior:**
- Content change regenerates embedding + `contentHash`.
- Kind/importance changes do NOT re-embed.
- Ownership checked via `assertOwned()` (joins `memories` with `threads`).

### `DELETE /api/memories/[id]` — Soft delete memory

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Response | 204 (no content) or 404 |

**Soft delete** — sets `suppressedAt` timestamp, does not physically delete. RAG search already filters by `suppressedAt IS NULL`. This preserves consistency with past conversation history.

---

## Skills

Skill CRUD. Skills are user-created reusable prompts with embeddings for RAG matching. See [Skills System](./skills.md).

### `GET /api/skills` — List skills

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | `Skill[]` (newest first) |

Returns the user's skills, ordered by `updatedAt DESC`. Excludes the `embedding` column.

**Response shape:**

```typescript
[
  {
    id: string;
    name: string;
    kind: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
    trigger: string | null;
    tags: string[] | null;
    status: "active" | "archived";
    version: number;
    sourceThreadId: string | null;
    contentHash: string;
    createdAt: string;
    updatedAt: string;
  }
]
```

### `POST /api/skills` — Create skill

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | `CreateBody` |
| Response | `{ id, name, content }` (201) or 400/409/503 |

Manually creates a skill. Generates embedding from combined `name + trigger + tags + content`.

**Request body:**

```typescript
{
  name: string;        // required
  content: string;     // required
  kind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
                          // default: "workflow"
  trigger?: string;
  tags?: string[];
}
```

**Behavior:**
- Duplicate check by `contentHash` → 409 Conflict if a skill with the same content already exists.
- Embedding source: `[name, trigger, tags.join(", "), content].filter(Boolean).join("\n")`.
- Embedding failure → 503.

### `PATCH /api/skills/[id]` — Update skill

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Body | `PatchBody` (partial) |
| Response | `Skill` (200) or 404 |

**Request body:**

```typescript
{
  name?: string;
  content?: string;    // triggers re-embed + contentHash + version bump
  kind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  trigger?: string;
  tags?: string[];
  status?: "active" | "archived";
}
```

**Behavior:**
- Re-embeds when any of `name`, `trigger`, `tags`, or `content` changes.
- `contentHash` and `version` are bumped only when `content` changes.
- Embedding failure → 503.

### `DELETE /api/skills/[id]` — Delete skill

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Response | 204 (no content) or 404 |

Physical delete. Scoped by `userId`.

---

## Skill Candidates

Skill candidates are auto-extracted from conversations and await user approval. See [Skills System](./skills.md) for the extraction and approval pipeline.

### `GET /api/skill-candidates` — List candidates

| Property | Value |
|----------|-------|
| Auth | Required |
| Query | `status` (optional: `draft` \| `approved` \| `rejected` \| `merged`) |
| Body | None |
| Response | `SkillCandidate[]` (newest first) |

**Query parameter:**

```
?status=draft      (default)
?status=approved
?status=rejected
?status=merged
```

Invalid `status` values default to `"draft"`.

**Response shape:**

```typescript
[
  {
    id: string;
    threadId: string;
    proposedName: string;
    proposedKind: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
    proposedTrigger: string | null;
    proposedContent: string;
    proposedTags: string[] | null;
    confidence: number;
    reason: string | null;
    status: "draft" | "approved" | "rejected" | "merged";
    createdAt: string;
    updatedAt: string;
  }
]
```

### `PATCH /api/skill-candidates/[id]` — Approve/reject candidate

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Body | `PatchBody` |
| Response | Approval result (200) or 404 |

**Request body:**

```typescript
{
  status: "approved" | "rejected";  // required
  // Override fields (only used when status="approved"):
  proposedName?: string;
  proposedKind?: "workflow" | "bugfix" | "project_rule" | "tool_usage" | "coding_pattern" | "debugging";
  proposedTrigger?: string;
  proposedTags?: string[];
  proposedContent?: string;
}
```

**Behavior when `status="approved"`:**
1. Computes embedding from candidate fields (overridable via body).
2. Checks for `contentHash` duplicate in `skills` table.
   - If duplicate exists → candidate status set to `"merged"`, returns `{ id, status: "merged", reason: "duplicate skill exists" }`.
3. Inserts a new row into the `skills` table with `sourceThreadId` = candidate's `threadId`.
4. Updates candidate status to `"approved"`.
5. Returns `{ candidate: { id, status: "approved" }, skill: {...} }`.

**Behavior when `status="rejected"`:**
- Sets candidate status to `"rejected"`.
- Returns `{ id, status: "rejected" }`.

**Response shapes:**

```typescript
// Approved
{ candidate: { id: string; status: "approved" }; skill: { id, name, content, kind, trigger, tags } }

// Merged (duplicate)
{ id: string; status: "merged"; reason: "duplicate skill exists" }

// Rejected
{ id: string; status: "rejected" }
```

### `DELETE /api/skill-candidates/[id]` — Delete candidate

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Response | 204 (no content) or 404 |

Physical delete. Scoped by `userId`. Intended for discarding draft candidates.

---

## MCP Servers

MCP (Model Context Protocol) server registration. MCP servers provide external tools to the chat. See [Tool Calling](./tool-calling.md).

### `GET /api/mcp-servers` — List MCP servers

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | `McpServer[]` (newest first) |

**Response shape:**

```typescript
[
  {
    id: string;
    name: string;
    transport: "http" | "stdio";
    url: string | null;
    command: string | null;
    args: string[] | null;
    env: Record<string, string> | null;
    createdAt: string;
    updatedAt: string;
  }
]
```

### `POST /api/mcp-servers` — Register MCP server

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | `CreateBody` |
| Response | `McpServer` (201) or 400 |

**Request body:**

```typescript
{
  name: string;                  // required
  transport: "http" | "stdio";   // required
  url?: string;                  // required when transport="http"
  command?: string;              // required when transport="stdio"
  args?: string[];              // stdio only
  env?: Record<string, string>; // stdio only
}
```

**Behavior:**
- `transport="http"` requires `url`.
- `transport="stdio"` requires `command`.
- `url`/`command`/`args`/`env` are set to `null` when not applicable to the transport type.

### `PATCH /api/mcp-servers/[id]` — Update MCP server

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Body | `PatchBody` (partial) |
| Response | `McpServer` (200) or 404 |

**Request body:**

```typescript
{
  name?: string;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
}
```

Note: `transport` cannot be changed after creation.

### `DELETE /api/mcp-servers/[id]` — Delete MCP server

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Response | 204 (no content) or 404 |

---

## Connections

OAuth-based connections to external services (currently Notion). See [Tool Calling](./tool-calling.md).

### `GET /api/connections` — List connections

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | `Connection[]` (newest first) |

Returns the user's connections. **Does not return `accessToken` or `refreshToken`** (prevents secret leakage).

**Response shape:**

```typescript
[
  {
    id: string;
    provider: string;         // e.g. "notion"
    workspaceName: string | null;
    workspaceIcon: string | null;
    ownerName: string | null;
    ownerEmail: string | null;
    createdAt: string;
    updatedAt: string;
  }
]
```

### `DELETE /api/connections` — Delete connection

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | `{ id: string }` |
| Response | 204 (no content) or 400 |

**Request body:**

```typescript
{ id: string }  // required
```

Only deletes rows owned by the authenticated user.

### `GET /api/connections/notion/authorize` — Start OAuth

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | 302 Redirect to Notion |

Redirects the user to Notion's OAuth authorization URL. Sets the user ID in the `state` parameter for CSRF prevention. Requires `NOTION_CLIENT_ID` env var (500 if not set).

The redirect URL format:

```
https://api.notion.com/v1/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&owner=user&state=<userId>
```

### `GET /api/connections/notion/callback` — OAuth callback

| Property | Value |
|----------|-------|
| Auth | Required |
| Query | `code`, `state`, `error` (from Notion redirect) |
| Response | 302 Redirect to `/` |

Handles the Notion OAuth callback.

**Flow:**
1. If `error` present → redirect to `/?connection_error=notion_denied`.
2. CSRF check: `state` must match the logged-in user ID. Mismatch → 400.
3. Exchanges `code` for a token via `exchangeNotionCode()`.
4. Saves the connection to the `connections` table with `accessToken`, `refreshToken`, `workspaceName`, `workspaceIcon`, `botId`, `ownerName`, `ownerEmail`.
5. Success → redirect to `/?connection_success=notion`.
6. Failure → redirect to `/?connection_error=notion_failed`.

**Connection record saved:**

```typescript
{
  userId: string;
  provider: "notion";
  accessToken: string;
  refreshToken: string | null;
  workspaceName: string | null;
  workspaceIcon: string | null;
  botId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
}
```

---

## Tunnel

Cloudflare Tunnel management for exposing the local instance publicly. See [Deployment](./deployment.md).

### `GET /api/tunnel` — Tunnel status

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | Tunnel status (200) |

**Response shape:**

```typescript
{
  running: boolean;
  hasToken: boolean;    // whether TUNNEL_TOKEN is set (token itself not returned)
  authUrl: string;      // current AUTH_URL
}
```

### `POST /api/tunnel` — Start tunnel

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | `TunnelBody` |
| Response | `{ success, ...status }` (200) or 400/500 |

**Request body:**

```typescript
{
  token?: string;     // Cloudflare Tunnel token (falls back to existing TUNNEL_TOKEN)
  authUrl?: string;   // public URL, must start with "https://"
}
```

**Behavior:**
1. Validates `token` (uses existing `TUNNEL_TOKEN` if omitted) and `authUrl` (must be `https://`).
2. Saves `TUNNEL_TOKEN` and `AUTH_URL` to `.env` and `process.env`.
3. Updates `process.env.AUTH_URL` dynamically — NextAuth reads it via `reqWithEnvURL` on each request (no restart needed).
4. Starts `cloudflared` via `startTunnel(token, { force: true })` — if already running, stops and restarts.
5. Returns updated tunnel status.

### `DELETE /api/tunnel` — Stop tunnel

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | `{ success, ...status }` (200) or 500 |

Stops the `cloudflared` process via `stopTunnel()`.

---

## Tor

Tor proxy management for the scraper service. The Tor container is always running via docker-compose; this API toggles whether the scraper routes through it.

### `GET /api/tor` — Tor status

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | Tor status (200) |

**Response shape:**

```typescript
{
  running: boolean;       // true if SCRAPE_PROXY === socks5://tor:9050
  scrapeProxy: string;   // current SCRAPE_PROXY value
  torProxy: string;      // current TOR_PROXY value
  socksProxy: string;    // "socks5://tor:9050"
  connection: {
    directIp: string | null;   // IP without Tor
    torIp: string | null;      // IP through Tor
    connected: boolean;        // true if directIp !== torIp
    error: string | null;
  };
}
```

**Behavior:**
- `running` is determined by whether `SCRAPE_PROXY` is set to `socks5://tor:9050`.
- If running, calls the scraper's `/tor-check` endpoint (45s timeout) to verify the Tor connection by comparing direct IP and Tor-routed IP.

### `POST /api/tor` — Toggle Tor proxy

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | `{ action: "start" | "stop" }` |
| Response | Toggle result (200) or 400/500 |

**Request body:**

```typescript
{
  action: "start" | "stop";  // required
}
```

**Behavior:**
- `action="start"`: Sets `SCRAPE_PROXY` and `TOR_PROXY` to `socks5://tor:9050` in `.env` and `process.env`.
- `action="stop"`: Sets both to empty string.
- After updating `.env`, restarts the scraper container via `docker compose restart scraper` (60s timeout) to reflect proxy changes.
- Error messages are localized via `t(locale, ...)`.

**Response shape:**

```typescript
{
  success: true;
  running: boolean;
  scrapeProxy: string;
  message: string;  // localized success message
}
```

---

## Global Instructions

Named, reusable system prompt snippets that can be attached to threads or set as a user default. See [Settings & Environment](./settings-env.md).

### `GET /api/global-instructions` — List instructions

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | None |
| Response | `GlobalInstruction[]` (newest first) |

**Response shape:**

```typescript
[
  {
    id: string;
    name: string;
    content: string;
    createdAt: string;
    updatedAt: string;
  }
]
```

### `POST /api/global-instructions` — Create instruction

| Property | Value |
|----------|-------|
| Auth | Required |
| Body | `CreateBody` |
| Response | `GlobalInstruction` (201) or 400 |

**Request body:**

```typescript
{
  name: string;     // required (non-empty)
  content: string;  // required (non-empty)
}
```

**Behavior:**
- Duplicate names are allowed (users can create multiple with the same name).
- Both `name` and `content` are trimmed; empty values → 400.

### `PATCH /api/global-instructions/[id]` — Update instruction

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Body | `PatchBody` (partial) |
| Response | `{ id, name, content }` (200) or 400/404 |

**Request body:**

```typescript
{
  name?: string;     // must not be empty (400 if blank)
  content?: string;  // allows empty (effectively disables it)
}
```

### `DELETE /api/global-instructions/[id]` — Delete instruction

| Property | Value |
|----------|-------|
| Auth | Required |
| Params | `id` (path) |
| Response | 204 (no content) or 404 |

**Behavior:**
- Via `ON DELETE SET NULL`, if the deleted instruction was referenced by `users.activeInstructionId` or `threads.globalInstructionId`, those references are automatically set to `null`.

---

## Auth

### `/api/auth/[...nextauth]` — NextAuth v5 route handler

| Property | Value |
|----------|-------|
| Auth | Public (handles its own auth) |
| Methods | GET, POST |
| Source | `src/auth.ts` (via `handlers` export) |

The NextAuth.js v5 catch-all route handler. Handles all auth flows: sign-in, sign-out, session, and OAuth callbacks.

```typescript
// src/app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/auth";
export const { GET, POST } = handlers;
```

**Supported providers:**
- **Credentials** — email/password (local DB).
- **Google OAuth** — when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.

**Key endpoints (handled internally by NextAuth):**
- `GET /api/auth/signin` — sign-in page
- `POST /api/auth/callback/credentials` — credentials callback
- `GET /api/auth/callback/google` — Google OAuth callback
- `GET /api/auth/signout` — sign-out
- `GET /api/auth/session` — session JSON

> **Full details:** See [Authentication & User Isolation](./authentication.md) for the auth configuration, session strategy, and provider setup.

---

## See also

- [Chat & Streaming](./chat-streaming.md) — SSE protocol, branching, dual-model, rapid mode
- [Database & Schema](./database.md) — table definitions, migrations, indexes
- [Authentication & User Isolation](./authentication.md) — Auth.js v5, per-user scoping
- [Settings & Environment](./settings-env.md) — `.env` configuration, cache invalidation
- [Memory System](./memory.md) — fact/working memory, RAG retrieval
- [Skills System](./skills.md) — skill kinds, auto-extraction, approval pipeline
- [Tool Calling](./tool-calling.md) — MCP integration, connections, tool probe
- [Deployment](./deployment.md) — Docker, Cloudflare Tunnel, Tor
