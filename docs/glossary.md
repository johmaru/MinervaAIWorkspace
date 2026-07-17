# Glossary — Domain Terms

UmansChat-specific terminology. Read this before reading code or docs — many
terms have project-specific meanings that differ from general AI/chat usage.

## Conversation Model

### Thread

A conversation container. The top-level entity. Each thread has:
- A message tree (not a flat list)
- A `currentLeafId` pointing at the currently displayed branch leaf
- A `userId` (owner), optional `folderId`, optional `systemPrompt`
- JSON-array columns `mcpServerIds` / `connectionIds` for per-thread tool enablement
- A `mode` (normal / rapid / dual)

DB table: `threads`

### Message

A single message in a thread. Messages form a **tree** via `parentId`:
- `parentId = null` → root message (first message in a thread)
- **send** → creates a **child** of the current leaf
- **edit** → creates a **sibling** (same `parentId` as the original)
- **regenerate** → creates a **sibling** assistant message (same `parentId` as the original assistant message)

DB table: `messages`

### Branch / Branching Model

ChatGPT-style message editing. Editing or regenerating a message does NOT
delete the original — it creates a sibling node. The user can navigate between
branches with `‹ 1/N ›` selectors. `threads.currentLeafId` tracks which branch
is displayed.

See: [Chat & Streaming](./chat-streaming.md) § Branching Model

### Leaf

The most recent message in a branch. `threads.currentLeafId` points to the
currently displayed leaf. The chain root → leaf is the visible conversation.

### Sibling Group

All messages sharing the same `parentId`. When you edit or regenerate, the
new message joins the sibling group of the original. The UI shows `‹ N/M ›`
to navigate within the group.

## Chat Modes

UmansChat has two response modes (`thread.responseMode`: `single` | `dual`)
and an optional `rapid` flag on the chat request body. The combinations are:

### Single Mode (default)

`responseMode: "single"`, `rapid: false`. Probes tool support; if supported,
streams with function-calling tools. If not, injects pre-search results as a
system message and streams without tools. Runs parallel context assembly
(search, URL, memory, skills).

### Rapid Mode

`responseMode: "single"`, `rapid: true`. A per-request boolean flag (not a
DB column). Pure single-stream LLM round-trip — no search, no memory, no
tools, no skills. Fastest response. Skips all four context-assembly promises.
Also skips `after()` memory generation and skill extraction.

### Dual Mode

`responseMode: "dual"`. Runs a cross-review or debate flow between two models
(`dualModelA` / `dualModelB`, strategy: `cross_review` or `debate`), then
streams the synthesis. Emits `dual_trace` SSE events showing the inter-model
dialogue.

See: [Chat & Streaming](./chat-streaming.md)

## SSE Protocol

The chat API returns a `ReadableStream<Uint8Array>` with
`Content-Type: text/event-stream`. Events:

| Event | Payload | When |
|-------|---------|------|
| `start` | `{ userMessageId, assistantMessageId }` | Stream begins |
| `status` | `{ message }` | Status update (e.g., "Searching web…") |
| `thinking` | `{ content }` | Model reasoning (if supported) |
| `delta` | `{ content }` | Incremental text chunk |
| `sources` | `{ sources: SourceInfo[] }` | Web search results (after `start`) |
| `dual_trace` | `{ round, model, content }` | Dual-mode inter-model dialogue |
| `done` | `{ content }` | Stream complete, final assistant content |
| `error` | `{ message }` | Error occurred |

Client parses these in `useChat.ts` → `streamChat()`. On `start`/`done`, the
client swaps optimistic message IDs for real DB IDs.

## Memory System

### Memory

A extracted fact or working-context note, stored with an embedding for RAG
retrieval. Generated **after** each assistant response via the `after()` callback.

- **kind:** `fact` (immutable info) or `working` (temporary context)
- **importance:** LLM-assigned score (0–1)
- **action:** `new` / `replace` (soft-delete old via `suppressedAt`) / `merge` (LLM integrates content)
- **scope:** determined by `folders.memoryScope` — `global` or `folder`

On the **next** send, `findRelevantMemories()` runs cosine similarity
(> 0.3 threshold), LLM rerank, then injects top-5 by recency-weighted score:
`importance * 0.6 + exp(-age_days / 14) * 0.4` (halves every 2 weeks).

DB table: `memories`

See: [Memory System](./memory.md)

### Recency Score

The ranking formula for memory retrieval:
`score = importance * 0.6 + exp(-age_days / 14) * 0.4`

Memories decay — their retrieval score halves every ~2 weeks unless reinforced
by new memories that merge or replace them.

## Skills System

### Skill

A user-approved reusable instruction. Six kinds:
`workflow`, `bugfix`, `project_rule`, `tool_usage`, `coding_pattern`, `debugging`.

Injected via semantic search (`similarity > 0.3`, top-5) or manual name match.

DB table: `skills`

### Skill Candidate

Auto-extracted draft instruction. Lifecycle: `draft` → `approved` / `rejected` /
`merged`. Extracted after each assistant response (alongside memory generation).
When approved, promoted to `skills` with an embedding.

DB table: `skill_candidates`

### Runtime Skills vs Developer Skills

**Runtime Skills** (DB `skills` table): User-facing reusable prompts stored in
SQLite, searched via embedding and injected into chat system context. Managed
via the Skill Manager UI (sidebar 🛠️ button).

**Developer Skills** (`.agents/skills/` directory): Markdown files read by AI
dev agents during development. Contain debugging pitfalls, project conventions,
and workflow recipes. Never read by the running app.

These are separate systems — do not mix them.

See: [Skills System](./skills.md)

## Knowledge & Search

### Page

A scraped web page, stored with its content and metadata. Deduplicated by
`contentHash`. When scraped, the content is chunked and embedded into
`page_embeddings` rows for semantic search.

DB table: `pages`

### Page Embedding

A chunk of a page's content, stored with its embedding vector. Used for
cross-thread semantic search alongside memories.

DB table: `page_embeddings`

### Embedding

A vector representation of text (message, memory, skill, or page chunk).
Stored as a JSON array in a `text` column. Cosine similarity is computed
in-process in JavaScript — no external vector DB.

Dimension depends on `EMBED_MODEL` (default 384 for all-MiniLM-L6-v2).
Changing the model triggers a DB migration.

See: [Embeddings & Vector Search](./embeddings.md)

### Content Hash

A hash of content used for deduplication. Pages with the same `contentHash`
are not re-scraped. Memories and skills use it to detect duplicate content.

## Organization

### Folder

A user-created container for organizing threads. Each folder has a
`memoryScope` setting (`global` or `folder`) that controls memory retrieval scope.

DB table: `folders`

### Global Instruction

A user-level system prompt that applies across all threads (unless overridden
by a thread-level `systemPrompt`). Cascading priority:
`thread.systemPrompt` → `global_instruction` → (default).

DB table: `global_instructions`

### Attachment

A file attached to a user message. Types:
- **Images:** stored as base64 dataURL, passed inline to vision models
- **PDFs:** text extracted server-side via `pdf-parse`, inserted as text
- **Text/JSON/code:** read as UTF-8, inserted into LLM context

Linked to both `threadId` and `messageId`. Max 10 MB.

DB table: `attachments`

## Tools & Integrations

### MCP Server

A Model Context Protocol server configured by the user. Enabled per-thread via
`thread.mcpServerIds`. The connection manager (`src/lib/mcpClient.ts`) handles
lifecycle.

**Transports:**
- `http` — Streamable HTTP with SSE fallback (default for remote servers).
- `sse` — Legacy SSE only (for servers exposing `/sse` endpoints).
- `stdio` — Local child process via `command` + `args` + `env`.

**Remote MCP (URL connector):** For `http`/`sse` transports, optional request
headers (`Authorization`, `X-API-Key`, etc.) can be attached for Bearer/API-key
authentication. URLs are SSRF-guarded (`src/lib/mcpUrlGuard.ts`) — private IPs
and metadata endpoints are rejected by default; set `MCP_ALLOW_PRIVATE_URLS=true`
for self-host/dev.

DB table: `mcp_servers`

See: [Tool Calling](./tool-calling.md)

### Connection

An external service integration. Enabled per-thread via
`thread.connectionIds`. Uses OAuth for authentication.

**Implemented providers:** Notion, GitHub, Gmail, Google Drive, Google Calendar,
Outlook Mail, Outlook Calendar. Each has its own tool-name prefix (e.g. `notion_`,
`gmail_`, `github_`) and dispatches via `resolveProviderFromToolName`.

**Remote MCP vs OAuth Connection:** Remote MCP servers own their own OAuth/tokens
(the MCP server handles auth, UmansChat only passes static headers). OAuth
Connections store tokens in UmansChat and expose hardcoded tools. Use remote MCP
for services not in the provider list above.

DB table: `connections`


### Tool Probe

A cached check (`src/lib/toolProbe.ts`) that determines whether the current LLM
model supports function-calling. Warmed up at module load. If unsupported, the
chat route falls back to injecting pre-search results as a system message.

### Tool Call Sanitizer

`src/lib/toolCallSanitizer.ts` — strips tool-call syntax from responses when
using a non-tool model. Prevents raw function-call JSON from appearing in the
chat UI.

## Personalization

### Style Preset

A predefined tone/style applied via system message (e.g., "concise", "detailed",
"friendly"). Configured per-thread or globally.

### Trait Slider

A user-adjustable personality dimension (e.g., formality, verbosity). Combined
with style presets to generate a personalized system message.

See: [Personalization](./personalization.md)

## Infrastructure

### Auth Guard

`getSessionUser()` from `src/lib/auth-guards.ts`. Called by **every** API route.
Returns the authenticated user or throws. Never bypass.

### User Isolation

Every data query includes `eq(table.userId, user.id)`. DELETE/PATCH always
combine the row id **and** userId in the WHERE clause. This prevents users
from accessing or modifying other users' data.

See: [Authentication & User Isolation](./authentication.md)

### `.env` as Source of Truth

Environment variables are the source of truth for all configuration. The
Settings GUI writes to `.env` via `src/lib/envUtils.ts`. Changes take effect
on next request (no restart needed for most settings).

See: [Settings & Environment](./settings-env.md)

### `after()` Callback

A Next.js API that schedules background work after the HTTP response is sent.
Used for memory generation and skill-candidate extraction. Must be called in the
POST handler body (request scope), NOT inside the `ReadableStream` `start()`
callback. See `AGENTS.md` for the critical pitfall.

### Cloudflare Tunnel

A reverse tunnel that exposes the local app to the internet. Managed via the
GUI (SettingsModal). Token changes and AUTH_URL switching take effect
immediately without restart. Uses a fixed cloudflared binary version with
SHA256 verification.

See: `AGENTS.md` → Cloudflare Tunnel GUI

### Standalone exe

A Windows executable (`UmansChat-<version>-windows-x64.zip`) built by
`scripts/pack-exe.ts` on Windows CI. Contains the same application code as the
Docker image. Uses `DATABASE_URL=":memory:"`.

See: [Deployment](./deployment.md)
