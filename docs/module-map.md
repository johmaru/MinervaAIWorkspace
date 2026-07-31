# Module Map — Boundaries & Safety Zones

Before editing, know which zone you're in. This map helps AI agents and
contributors understand the blast radius of their changes.

## Safety Legend

| Symbol | Meaning |
|--------|---------|
| 🟢 | **Safe zone** — well-isolated, edit freely. Changes rarely break other modules. |
| 🟡 | **Caution zone** — edit carefully. Other modules depend on your interface. Read the relevant doc first. |
| 🔴 | **High-risk zone** — read docs + existing code thoroughly. Known pitfalls apply. Small mistakes break the app. |

---

## 🟢 Safe Zones

These modules are self-contained. They have clear interfaces and low coupling.
Edit with confidence — just follow existing patterns and add tests.

### `src/components/`

React UI components. Each component is fairly independent.

- **Key files:** `ChatShell.tsx`, `ChatWindow.tsx`, `Sidebar.tsx`, `SettingsModal.tsx`,
  `Markdown.tsx`, `MemoryViewerModal.tsx`, `SkillManagerModal.tsx`, `ThreadSettings.tsx`,
  `AttachmentBar.tsx`, `SearchBar.tsx`, `UrlInput.tsx`, `ContextMenu.tsx`,
  `ThemeToggle.tsx`, `LanguageToggle.tsx`, etc.
- **Docs:** [Frontend Components](./frontend.md)
- **Rules:** Use `"use client"` only when needed. Reuse animation/UI
  primitives from `src/components/ui/motion.tsx` (`MotionButton`,
  `AnimateModal`, `Accordion`). Follow Tailwind theme tokens, not
  hardcoded colours.
- **Tests:** Co-locate `*.test.tsx`, default jsdom environment.

### `src/hooks/`

Client-side state management hooks.

- **Key files:** `useChat.ts`, `useThreads.ts`, `useFolders.ts`
- **Docs:** [Hooks & State](./hooks.md)
- **Exception:** `useChat.ts` is borderline 🟡 — it handles the full SSE protocol,
  optimistic UI, and branching model. Read [Chat & Streaming](./chat-streaming.md) first.

### `src/lib/i18n/`

Internationalization dictionaries (Japanese source, English mirrored).

- **Key files:** `dictionaries.ts`, `index.ts`
- **Docs:** [i18n & Theming](./i18n-theming.md)
- **Rule:** Both languages must stay aligned. Add a key to `ja` first, then `en`.

### `embedder/`, `scraper/`

Standalone Python services. Completely separate from the Next.js app.

- **Docs:** [Architecture Overview](./architecture.md) (service topology)

### `searxng/`

SearXNG configuration files.

---

## 🟡 Caution Zones

These modules are used by multiple consumers. Changing their interfaces breaks
callers. Check references before modifying exported symbols.

### `src/app/api/` (individual route handlers)

Each route handler is fairly independent, but they share patterns: auth guard,
user scoping, error handling.

- **Pattern:** See [API Route Pattern](./patterns/api-route.md)
- **Auth:** Every route calls `getSessionUser()` from `src/lib/auth-guards.ts`.
- **User isolation:** Every query includes `eq(table.userId, user.id)`.
- **Testing:** `// @vitest-environment node` as first line. Mock auth via `getSessionUser`.
- **Docs:** [API Routes Reference](./api-routes.md)

### `src/lib/` (individual modules)

Business logic. Each file is fairly independent, but many are imported by the
chat route and other API routes.

- **`memory.ts`** / **`memoryStore.ts`** — memory generation & retrieval. Read
  [Memory System](./memory.md) first.
- **`skillStore.ts`** / **`skillCandidate.ts`** / **`skillGenerator.ts`** — skills
  pipeline. Read [Skills System](./skills.md) first.
- **`embed.ts`** — embedding pipeline. Changing `EMBED_DIM` triggers a DB migration.
  Read [Embeddings & Vector Search](./embeddings.md) first.
- **`vectorSearch.ts`** — pure JS cosine similarity. No dependencies.
- **`scraper.ts`** — HTTP client to the scraper service.
- **`mcpClient.ts`** — MCP server connection manager. Read [Tool Calling](./tool-calling.md) first.
- **`personalization.ts`** — style/trait → system message. Read [Personalization](./personalization.md).
- **`searchDecision.ts`** — heuristic + LLM router for search necessity.
- **`envUtils.ts`** — `.env` read/write helpers.
- **`tunnel.ts`** — Cloudflare Tunnel binary management. Borderline 🔴 — see below.
- **`toolProbe.ts`** / **`toolCallSanitizer.ts`** — tool support detection.
- **`urlExtract.ts`** / **`wikipedia.ts`** / **`clientFetch.ts`** — utility clients.
- **`sandbox/`** — isolated code execution (Tier 1 `code_run` only in v0.4).
  Docker-backed; `runSandbox()` orchestrates policy → admission → staging →
  lifecycle → sanitize. Read [Sandbox Architecture](./superpowers/specs/2026-07-15-sandbox-architecture-design.md)
  and [Tool Calling](./tool-calling.md) first. `🟡` — wired into the chat
  route; changing the `sandbox_run` tool shape or error codes affects the LLM.

### `src/db/schema.ts`

Drizzle ORM schema. Any change requires a migration.

- **Docs:** [Database & Schema](./database.md)
- **Migration:** See [DB Migration Pattern](./patterns/db-migration.md)
- **Rule:** Never edit an existing migration file. Always generate a new one.

### `scripts/`

Build and packaging scripts.

- **`pack-exe.ts`** — assembles the Windows standalone exe.
- **`sync-env.ts`** — syncs `.env` to runtime config.

### `launcher/`

Standalone exe launcher (`minerva-launcher.cjs`).

---

## 🔴 High-Risk Zones

These modules have known pitfalls, complex state machines, or are load-bearing.
**Read the linked docs and existing code thoroughly before editing.**
The `AGENTS.md` known-pitfalls section applies here.

### `src/app/api/chat/route.ts` — The Orchestrator

The single most complex file in the project. Handles:
- SSE streaming protocol (start, status, thinking, delta, sources, dual_trace, done, error)
- Branching model (send / regenerate / edit)
- Three modes: normal, rapid, dual
- Parallel context assembly (search, URL, memory, skills)
- MCP tool integration
- `after()` callback for memory generation + skill extraction

- **Docs:** [Chat & Streaming](./chat-streaming.md)
- **Critical pitfall:** `generateMemories` must run via `after()` in the POST handler
  body, NOT inside the `ReadableStream` `start()` callback. See `AGENTS.md` and
  `skill://minerva-debug` for the full explanation.
- **Testing:** Mock the LLM. Test branching logic, mode switching, and SSE event
  ordering. Do NOT test with a real LLM unless using the `itReal()` pattern.

### `src/db/index.ts` — SQLite Singleton

The database connection. Uses `better-sqlite3` with integrity recovery.
Changing this can corrupt the database or break all queries.

- **Docs:** [Database & Schema](./database.md)
- **Rule:** Never change the singleton pattern without understanding the integrity
  recovery logic.

### `src/auth.ts` / `src/auth.config.ts` / `src/lib/auth-guards.ts`

Authentication and authorization.

- **Docs:** [Authentication & User Isolation](./authentication.md)
- **Rule:** Every API route MUST call `getSessionUser()`. Never bypass auth.
- **User isolation:** Every data query MUST scope by `userId`.

### `src/hooks/useChat.ts` — Chat State Machine

Manages the full client-side chat state: message tree, SSE parsing, optimistic
UI, branch navigation, ID swapping.

- **Docs:** [Chat & Streaming](./chat-streaming.md), [Hooks & State](./hooks.md)
- **Risk:** Incorrect SSE event handling causes UI freezes, lost messages, or
  duplicate branches.

### `src/lib/tunnel.ts` — Cloudflare Tunnel

Binary management with SHA256 verification, platform-specific code paths.

- **Docs:** `AGENTS.md` → Cloudflare Tunnel GUI section
- **Rule:** Never change the hardcoded SHA256 hashes without local verification.
  Never disable HTTPS-only or auto-update checks.

### `src/lib/embed.ts` — Embedding Pipeline

Supports local (transformers.js) and HTTP (Python embedder) modes.
Changing `EMBED_DIM` triggers a DB migration that recreates vector columns.

- **Docs:** [Embeddings & Vector Search](./embeddings.md)
- **Migration:** See [DB Migration Pattern](./patterns/db-migration.md)

### `src/lib/llm.ts` — LLM Client

OpenAI SDK client with configurable baseURL, model, and reasoning effort.

- **Docs:** [Chat & Streaming](./chat-streaming.md)

### `Dockerfile` / `docker-compose.yml` — Deployment Topology

- **Docs:** [Deployment](./deployment.md)
- **Rule:** The exe and Docker distributions must have parity. See `AGENTS.md` →
  Release & Distribution → Parity rule.

### `next.config.ts` / `auth.config.ts` / `proxy.ts`

Framework configuration. Changes here affect the entire app.

---

## Cross-Cutting Concerns

These patterns apply everywhere, not to a single module:

| Concern | Where | Doc |
|---------|-------|-----|
| Auth guard (`getSessionUser`) | Every API route | [Authentication](./authentication.md) |
| User isolation (`eq(userId)`) | Every data query | [Authentication](./authentication.md) |
| SSE event protocol | `useChat.ts` ↔ `chat/route.ts` | [Chat & Streaming](./chat-streaming.md) |
| Embedding dimension | `embed.ts` ↔ `schema.ts` ↔ `settings` route | [Embeddings](./embeddings.md) |
| `.env` as source of truth | `envUtils.ts` ↔ settings route | [Settings & Env](./settings-env.md) |
| Test environment annotation | All `src/lib/*` and `src/app/api/**` tests | [Testing Guide](./testing.md) |
