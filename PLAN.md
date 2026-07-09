# UmansChat — Design & Implementation Plan

A ChatGPT-like chat window. Converse with UmansAI / OpenAI-compatible LLMs.
Uses PostgreSQL + pgvector for hybrid RDB + vector operations in a single database.
Message editing follows the ChatGPT-style branching model. UI is minimal and hand-built.

## Confirmed Decisions

| Item | Decision |
|---|---|
| Frontend | Next.js 15 (App Router) + React 19 + TypeScript + Tailwind |
| Backend | Route Handlers / OpenAI-compatible SDK (switchable baseURL) |
| Storage | PostgreSQL + `pgvector` (single-DB hybrid) |
| ORM | Drizzle ORM |
| Vector use | Semantic search + long-term memory RAG |
| Message editing | Branching (parent-pointer tree, `threads.current_leaf_id`) |
| Design | Minimal, hand-built (monochrome + 1 accent, divider lines, narrow sidebar) |
| Runtime | Docker Compose (Next + Postgres) |

## Architecture

```
Browser ──> Next.js Route Handlers ──> OpenAI-compatible LLM (env: LLM_BASE_URL)
   │             │
   │             v
   │      PostgreSQL + pgvector
   │       - threads (RDB)
   │       - messages (RDB, parent_id self-reference for tree)
   │       - embeddings (vector(1536))  -- for RAG/search
   │
   └─ localStorage: offline cache (optional)
```

### Data Model Overview

```
threads
  id, title, system_prompt, model, current_leaf_id, created_at, updated_at

messages
  id, thread_id, parent_id (self-reference, NULL=root), role, content,
  created_at
  -- Branching: edit/regenerate creates a new record and links via parent_id

embeddings
  id, message_id, content_hash, embedding vector(1536), model, created_at
```

### Branching Behavior

- Edit a user message → the original message is kept; a new message (parent_id=same parent) is created.
- `threads.current_leaf_id` is updated to the new message. Branches can be selected in the sidebar.
- Regeneration uses the same mechanism: a new assistant message is created, with parent_id pointing to the user message.

## Phases

### Phase 0: Scaffold
- Initialize Next.js + TS + Tailwind
- Docker Compose (Next + Postgres with pgvector)
- Drizzle schema + initial migration
- Skeleton layout (sidebar + main)

### Phase 1: Streaming chat ✅
- Single-thread chat UI (message list + input field)
- `/api/chat` Route Handler, streaming via SSE
- OpenAI-compatible client (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` env)
- Automated tests: Vitest + React Testing Library (includes SSE verification with real API, 30 tests green)

### Phase 2: Threads + persistence ✅
- Sidebar: thread CRUD (create/select/rename/delete)
- Message Postgres persistence (/api/chat saves user/assistant to DB)
- Optimistic updates (state + fetch; SWR/React Query considered for optimization phase)
- Auto-generate title (first 40 chars of initial user message)
- Automated tests: 55 tests green (includes real API SSE + DB persistence)

### Phase 3: Markdown + theme ✅
- `react-markdown` + `remark-gfm` + `rehype-highlight` + `rehype-katex` (KaTeX)
- Dark mode via `next-themes` (system / light / dark toggle)
- Syntax highlighting (highlight.js github-dark), math ($...$ / $$...$$)
- Automated tests: 75 tests green (Markdown 10 tests + ThemeToggle 4 tests added)
### Phase 4: System prompt + model ✅
- Per-thread system prompt editing (collapsible field)
- Model selector (candidate list via LLM_MODELS env, GET /api/models)
- Added updateThread to useChat (PATCH /api/threads?id=...)
- Automated tests: 88 tests green (ThreadSettings 9 tests + models API 4 tests added)

### Phase 5: Stop / regenerate / edit ✅
- Stop generation via `AbortController` (stop button)
- Regenerate button → generates a new assistant branch from parentMessageId
- Message editing → creates a new user sibling branch + assistant response
- Branch navigation `‹ 1/2 ›` selector (group by same parentId in siblingGroups)
- Chat API supports 3 modes: send / regenerate / edit
- `buildContextChain()` traces the parent chain to build LLM context
- `threads.currentLeafId` tracks the currently displayed branch
- Automated tests: 92 tests green (branching 4 tests added: siblings, switchBranch, regenerate, editMessage)

### Phase 6: File attachments ✅
- Images: stored as base64 dataURL in DB, passed inline to vision models
- PDF: text extraction via `pdf-parse`, inserted as text part into LLM context
- Text/JSON/code: read as UTF-8, inserted into LLM context
- `attachments` table (threadId + nullable messageId)
- `POST /api/upload` (multipart/form-data) + link via `attachmentIds` in chat API
- `AttachmentBar` component (thumbnail + delete button)
- 📎 File attachment button (multiple selection, 10MB limit)
- Automated tests: 100 tests green (AttachmentBar 8 tests added)

### Phase 7: Vector RAG + search ✅
- Local embedding via `@xenova/transformers` (all-MiniLM-L6-v2, 384 dimensions)
- Asynchronously embed user + assistant messages after response completion (dedup via contentHash)
- `POST /api/search`: cross-thread semantic search via pgvector cosine distance
- RAG: on send, search top-5 similar messages from other threads and inject into system context (similarity > 0.5)
- `SearchBar` component (sidebar, dropdown results, similarity % display)
- Dockerfile: added `.dockerignore`, removed bundled sharp for transformers.js to work
- Automated tests: 110 tests green (embed 4 tests + SearchBar 6 tests added)

### Phase 8: UI polish ✅
- Mobile sidebar (hamburger button + overlay + Esc to close)
- Responsive: adjust padding, gap, max-width at `sm:` / `md:` breakpoints
- a11y: ARIA labels, roles, aria-live, aria-expanded, aria-controls, aria-hidden
- focus-visible outline (WCAG AA compliant), contrast improvements
- Automated tests: 119 tests green (ChatShell 9 tests added)

### Phase 9: URL scraping + IP block avoidance ✅
- Scrapling (Python) FastAPI microservice (`scraper/`) for web page fetching
  - `AsyncFetcher.get()` combines TLS fingerprint impersonation (`impersonate='chrome'`) + `stealthy_headers=True` + `retries=3`
  - Respects robots.txt (disallow for `User-agent: *` blocks, fail-open)
  - Added `scraper` service to docker-compose (port 8000)
- Added `pages` + `page_embeddings` tables (pgvector 384-dim, HNSW index)
- `POST /api/scrape`: URL ingestion → scrape → embed → persist as knowledge (cached via contentHash)
- Added `pages` field to `POST /api/search` (cross-thread page search)
- Page RAG injection in `findRelevantMessages()` (similarity > 0.3, messages > 0.5)
- `UrlInput` component (sidebar, Enter to ingest)
- Added 🌐 Web Knowledge section to `SearchBar` (page results shown as external links)
- Changed vitest pool to threads (sharp native module crashes with forks pool)
- Automated tests: 152 tests green (scraper 9 + scrape route 8 + search route 3 + UrlInput 6 + SearchBar 2 added, Python 15+1skip)

### Phase 10: Web search + auto-knowledge ✅
- Added SearXNG (self-hosted metasearch) + Tor proxy to docker-compose
  - `searxng` service: JSON API enabled (`formats: [html, json]` in `settings.yml`)
  - `tor` service: SOCKS5 proxy (`dperson/torproxy`, dynamic switching via `SCRAPE_PROXY` env)
  - Added `SEARXNG_URL` / `TOR_PROXY` / `SCRAPE_PROXY` env to `app` / `scraper`
- Added `POST /search` endpoint to `scraper/main.py`
  - Sends search request to SearXNG (JSON API via httpx) → parallel scraping of top URLs via `asyncio.gather`
  - `scrape_url_safe()` reuses existing `is_safe_host` / `extract_title` / `extract_text` (SSRF protection inherited)
  - `SCRAPE_PROXY` toggles Tor-based scraping
- Added `searchWeb()` + `SourceInfo` / `WebSearchResult` types to `src/lib/scraper.ts`
- New `src/lib/pageStore.ts`: `upsertPage()` consolidates upsert + embed for pages + page_embeddings
  - Refactored `/api/scrape` route to call `upsertPage` (deduplication)
- `/api/chat` route: on send, performs web search → scrapes top 3 results → stores as knowledge in pages table → RAG injection
  - Added SSE `sources` event (`send("sources", { sources })` sent right after `start`)
- `useChat` hook: `sources` state + SSE `sources` event handling (cleared on send/switch)
- `ChatWindow`: displays "📚 Sources: N" below the latest assistant message (external links with `target="_blank"`)
- Tor toggle: `SCRAPE_PROXY` env handles the scraper side dynamically; SearXNG side toggled by editing `outgoing.using_tor_proxy` in `settings.yml`
- Automated tests: 161 vitest green (searchWeb 4 + pageStore 3 + useChat sources 1 + chat route sources 1 + ChatWindow fix, Python 34+2skip: search endpoint 3 + scrape_url_safe 3 added)
- GUI settings modal: all `.env` settings editable via GUI from the ⚙️ button in the sidebar
  - `GET/POST /api/settings`: fetch all settings + save to `.env` + vector column migration on dimension change
  - `SettingsModal` component: 5 sections (LLM / Embedding / Web Search / Tor / DB) with 12 items
  - LLM settings: BASE_URL, API_KEY, MODEL, MODELS, **Thinking Effort** (low/medium/high)
  - Embedding model: select from 4 candidates, migration confirmation on dimension change
  - Web search: max results count, SCRAPER_URL, SEARXNG_URL
  - Tor proxy: TOR_PROXY, SCRAPE_PROXY (empty = no Tor, socks5://tor:9050 = Tor enabled)
  - Database: DATABASE_URL
  - On dimension change: warning shown → checkbox confirmation → recreate vector column (including HNSW index)
- Thinking Effort: controls LLM reasoning intensity via `THINKING_EFFORT` env (sent as `reasoning_effort` parameter in chat route)
- `.env` mount: mounts host `.env` into container (`volumes: ./.env:/app/.env`) + loaded via `env_file`
  - GUI-modified `.env` persists across rebuilds (not baked into the image)
- Embedding model environment variable support: dynamic switching via `EMBED_MODEL` / `EMBED_DIM` / `WEB_SEARCH_MAX_RESULTS`
  - `embed.ts` / `schema.ts` / `pageStore.ts` / chat route reference env
  - Candidates: all-MiniLM-L6-v2 (384), paraphrase-multilingual-MiniLM-L12-v2 (384, recommended), multilingual-e5-small (384), multilingual-e5-base (768)
- Search accuracy improvement: solved the issue where sending long Japanese questions directly to SearXNG degrades accuracy
  - `extractSearchQuery()`: uses LLM to extract keywords from the question (e.g., "Is Project Motor Racing 2.0 getting good reviews?" → "Project Motor Racing 2.0 review"). Falls back to the original question on failure
  - Expanded scraped body text injection from 2000→4000 chars to prevent loss of key info like "2.0"
  - Failed scrape pages fall back to SearXNG snippets (avoids zero-information results)
  - Removed `page_embeddings` search from `findRelevantMessages()`: duplicates and noise increase when combined with pages directly injected by web search. Now focuses solely on past message search
- E2E verified: SearXNG search → parallel scraping → `sources` SSE → 3 sources displayed in frontend
- GUI verified: edited all settings in settings modal → changed Thinking Effort to high → saved → confirmed settings persist after rebuild

### Phase 11: UI refresh — abyssal gradient + glass-card ✅
- Resolved the "flat" look from the previous phase (Slate Lavender + glassmorphism)
  - `--background` from `#0d1117` → `#0a0e17` (one step darker), `--muted` from `#161a26` → `#1c2235` (contrast ratio 1.09→1.5, making elements stand out)
  - New variable `--glow` (for accent glow, dark `rgba(129,140,248,0.15)` / light `rgba(99,102,241,0.12)`) registered as `--color-glow` in `@theme inline`
- Body background: two-layer radial-gradient with doubled alpha (`background-attachment: fixed, fixed` for scroll-lock)
  - `.dark body` overrides only `background-image`; inherits `background-attachment` and `background-size`
  - **Noise SVG removed**: initially added `feTurbulence` noise, but `<rect width="100%">` rendered opaque noise across the entire surface, creating a "sandstorm" effect (the plan's "subtle overlay" assumption was technically incorrect). The gradient + glass-card provide sufficient depth, so it was removed
- `.glass-card` utility: `inset 0 1px 0 0` inner highlight + subtle outer shadow for "depth" (light = white highlight, dark = lavender highlight)
- Applied to: Sidebar aside / ThreadRow selected row / ChatWindow assistant bubble · input field upward shadow · send button `--glow` glow · user bubble `--glow` outer shadow · sources · ThinkingBlock / 3 modal bodies · SearchBar dropdown · ContextMenu portal
  - Avoided `shadow-*` and `glass-card` box-shadow conflicts: removed `shadow-*` from elements with `glass-card`
- Safe list maintained: text · aria · role · `text-red-500` · `.h-px.bg-border` all unchanged — only className/CSS
- Verification: typecheck green / build green / Docker rebuild + production CSS chunk confirmed feTurbulence=0 (sandstorm resolved), glass-card · radial-gradient · 0a0e17 · 1c2235 · background-attachment:fixed,fixed confirmed

### Phase 12: Conversation memory system — fact/working memory extraction, retrieval, injection ✅
- Removed the `embeddings` table (dead table: no reads or writes) and added a new `memories` table
  - `kind` (fact/working), `content`, `embedding`, `importance`, `suppressedAt` (soft delete), `folderId` (scope determination)
  - HNSW index for cosine similarity search
- Memory generation (`src/lib/memory.ts`): summarizes and classifies conversations via LLM after assistant response completes
  - Classifies as fact (immutable info) / working (temporary context)
  - Action determination: new / replace (soft delete via suppressedAt) / merge (integrate content via LLM)
  - Runs asynchronously as fire-and-forget (does not block stream completion)
- Memory retrieval (`src/lib/memoryStore.ts`): on next send, performs pgvector search → LLM rerank → top-5 by recency score
  - If `folders.memoryScope` is "folder", searches only within the same folder; "global" searches across all threads
  - recency: `importance * 0.6 + exp(-age_days / 14) * 0.4` (halves every 2 weeks)
- chat route integration: injects memory system message into `buildFinalMessages` (right after systemPrompt, before history)
- search route switch: `embeddings` → `memories` table, response type `messageId`→`memoryId`/`role`→`kind`
- settings route switch: `embeddings` → `memories` for vector column dimension management
- Migration `0005_memories.sql`: CREATE memories + DROP embeddings CASCADE + HNSW index
- Tests: 31 tests green (memory.test.ts 6 + memoryStore.test.ts 4 + search 4 + settings 4 + chat 11 + SearchBar 2)

## Environment Variables (Expected)

```
DATABASE_URL=postgres://...
LLM_BASE_URL=https://api.openai.com/v1   # or UmansAI / local
LLM_API_KEY=...
LLM_MODEL=gpt-4o-mini
EMBED_MODEL=text-embedding-3-small
EMBED_DIM=1536
SCRAPER_URL=http://localhost:8000       # or http://scraper:8000 in Docker
SEARXNG_URL=http://localhost:8080       # or http://searxng:8080 in Docker
TOR_PROXY=                               # empty = no Tor, socks5://tor:9050 = Tor
SCRAPE_PROXY=                            # empty = no Tor, socks5://tor:9050 = Tor
# Embedding models (transformers.js):
#   Xenova/all-MiniLM-L6-v2               (384-dim, English-focused, default)
#   Xenova/paraphrase-multilingual-MiniLM-L12-v2 (384-dim, multilingual incl. Japanese, recommended)
#   Xenova/multilingual-e5-base            (768-dim, multilingual, high accuracy)
# When switching models, update EMBED_DIM accordingly + DB migration required
EMBED_MODEL=Xenova/all-MiniLM-L6-v2
EMBED_DIM=384
# Number of web search sources to fetch and scrape on chat send
WEB_SEARCH_MAX_RESULTS=3
```

## Running

```
docker compose up -d
# Next: http://localhost:3000
# Postgres: localhost:5432
```
