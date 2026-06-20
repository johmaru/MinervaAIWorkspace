# UmansChat

A self-hosted, streaming AI chat platform with branching conversations, semantic search, and web knowledge ingestion.

[日本語 / Japanese](./README.ja.md)

## Features

- **Streaming chat** with SSE (token-by-token output)
- **Branching conversation tree** — regenerate or edit a message to create sibling nodes; navigate siblings with `< 1/N >`
- **File attachments** — images (vision), PDF (text extraction), text/code files (max 10MB per file)
- **Semantic search** across all threads (pgvector cosine similarity)
- **Conversation memory** — fact/working memories extracted after each turn and injected as RAG context
- **Web page scraping → knowledge ingestion** — scraped pages become a RAG source for future answers
- **App-level search pipeline** — a separate LLM call decides whether to search, shows a short notice, fetches results via SearXNG, then injects them as context for the final answer
- **Dual-model conclusions** — run two models in cross-review or debate mode, then stream a synthesized final answer with the model work kept in collapsible details
- **Tor proxy** support for anonymous scraping
- **Thinking effort control** — per-model reasoning levels (e.g. GLM-5.2: `none`/`high`/`max`, Flash: `none`/`low`/`medium`/`high`); ignored for models without reasoning control
- **Embedding model switching** — local ONNX via transformers.js, or an HTTP Python embedder service
- **Folder organization** for threads
- **Dark / light / system theme**
- **EN / JA i18n toggle** (English is the default)
- **OpenAI-compatible LLM backend** — UmansAI, OpenAI, vLLM, Ollama, etc.
- **Auto title generation** from the first user message
- **Per-thread system prompt and model selection**
- **Settings GUI** that writes to `.env` (no restart needed for config changes, except embedding-model migration)

## Architecture

UmansChat is a Next.js 16 + React 19 app backed by PostgreSQL 16 with pgvector, orchestrated by Docker Compose across five services:

```mermaid
flowchart LR
    subgraph Client
        Browser[Browser :3001]
    end
    subgraph Compose
        app[app<br/>Next.js 16 + Bun]
        db[(db<br/>pgvector pg16)]
        embedder[embedder<br/>Python sentence-transformers]
        scraper[scraper<br/>Scrapling FastAPI]
        searxng[searxng<br/>meta search]
        tor[tor<br/>dperson/torproxy]
    end
    Browser --> app
    app --> db
    app --> embedder
    app --> scraper
    scraper --> searxng
    searxng --> tor
```

| Service    | Image / Build        | Role                                            | Port           |
|------------|----------------------|-------------------------------------------------|----------------|
| `app`      | Built from `Dockerfile` | Next.js app (chat UI, API, settings)         | `3001 → 3000`  |
| `db`       | `pgvector/pgvector:pg16` | PostgreSQL 16 with vector extensions        | `5432`         |
| `embedder` | Built from `./embedder` | Python `sentence-transformers` HTTP embedder | `8000` (exposed) |
| `scraper`  | Built from `./scraper`  | Scrapling FastAPI scraper + SearXNG client    | `8000` (exposed) |
| `searxng`  | `searxng/searxng:latest` | SearXNG meta-search engine                    | `8081 → 8080`  |
| `tor`      | `dperson/torproxy:latest` | Tor SOCKS proxy for anonymous scraping      | `9050` (exposed) |

## Requirements

- **Node.js / Bun** — Bun is the primary runtime and package manager
- **Docker** (with Docker Compose) — for the database, scraper, embedder, search, and Tor services
- An **OpenAI-compatible LLM API key** (UmansAI, OpenAI, vLLM, Ollama, etc.)

## Quick Start (Docker)

This is the recommended path for running UmansChat as a self-contained service.

```bash
# 1. Copy the environment template
cp .env.example .env

# 2. Set your LLM API key (required)
#    Edit .env and fill in LLM_API_KEY
#    Optionally set LLM_BASE_URL and LLM_MODEL for your provider

# 3. Start all services
docker compose up -d

# 4. Open the app
#    http://localhost:3001
```

On first run, database migrations are applied automatically by the app. If you change the embedding model after initial setup, see [Database Migrations](#database-migrations).

## Quick Start (Local Dev)

For development of the Next.js app itself.

```bash
# 1. Install dependencies
bun install

# 2. Start the database (and optionally other services) via Docker
docker compose up -d db

# 3. Copy the environment template and configure
cp .env.example .env
#    Set DATABASE_URL, LLM_API_KEY, and (for scraping/search) the service URLs

# 4. Run the dev server
bun run dev
#    http://localhost:3000
```

The scraper, embedder, searxng, and tor services can be started alongside the database when you need scraping/search during local development:

```bash
docker compose up -d db scraper embedder searxng tor
```

Point `SCRAPER_URL`, `SEARXNG_URL`, and (for HTTP embeddings) `EMBEDDER_URL` in `.env` to the host-exposed ports when running the app outside Compose.

## Configuration

All configuration lives in `.env` (see `.env.example` as the source of truth). The in-app Settings GUI can edit most of these at runtime without a restart.

| Variable                | Description                                                        | Default                                              |
|-------------------------|--------------------------------------------------------------------|------------------------------------------------------|
| `LLM_BASE_URL`          | Base URL of the OpenAI-compatible API (Umans mode auto-fetches models when `api.code.umans.ai`) | `https://api.code.umans.ai/v1`                       |
| `LLM_API_KEY`           | API key (required)                                                 | —                                                    |
| `LLM_MODEL`             | Default model                                                      | `umans-glm-5.2`                                      |
| `LLM_MODELS`            | Comma-separated model list (OAI-compat mode only; ignored in Umans mode) | —                                                    |
| `THINKING_EFFORT`       | Reasoning level (`none`/`low`/`medium`/`high`/`max`, per model)  | `medium`                                             |
| `EMBED_MODEL`           | Embedding model name                                               | `Xenova/all-MiniLM-L6-v2`                            |
| `EMBED_DIM`             | Embedding dimension                                                | `384`                                                |
| `WEB_SEARCH_MAX_RESULTS`| Number of results fetched (and scraped) per chat send              | `3`                                                  |
| `WEB_SEARCH_MAX_ROUNDS` | Deprecated — search round count is now determined by the search decision LLM (1-3 queries per response) | `2`                                                  |
| `SCRAPER_URL`           | Scraper microservice URL                                           | `http://localhost:8000`                              |
| `SEARXNG_URL`           | SearXNG URL                                                        | `http://localhost:8080`                              |
| `TOR_PROXY`             | Tor proxy for the app (reference; empty = no Tor)                 | —                                                    |
| `SCRAPE_PROXY`           | Proxy used by the scraper when scraping                            | —                                                    |
| `DATABASE_URL`          | PostgreSQL connection URL (used for local `bun run dev`)           | `postgres://umans:umans@localhost:5432/umanschat`    |

## LLM Provider Modes

UmansChat supports two modes, switched automatically by `LLM_BASE_URL`:

### Umans mode (default)

When `LLM_BASE_URL` points to `api.code.umans.ai` (e.g. `https://api.code.umans.ai/v1`):

- The model list and reasoning levels are **auto-fetched** from `/v1/models/info` at startup (cached in-process).
- Models appear in the selector with their **display names** (e.g. `Umans Qwen3.6 35B A3B`).
- `LLM_MODELS` is **ignored** — the API is the source of truth.
- On API failure, falls back to the built-in `MODEL_REASONING` table.

### OpenAI-compatible mode

When `LLM_BASE_URL` points elsewhere (OpenAI, vLLM, Ollama, etc.):

- The model list is taken from `LLM_MODELS` (comma-separated, e.g. `gpt-4o,gpt-4o-mini`).
- Display names are not available — model IDs are shown as-is.
- Reasoning levels fall back to `MODEL_REASONING` for known Umans models, or empty for others.

Change `LLM_BASE_URL` in the Settings GUI or `.env` to switch modes. No restart is needed when using the Settings GUI.

## Usage

- **Create a thread** — start typing in the composer; the thread is created on first send and an auto title is generated from your first message.
- **Send a message** — press `Enter` to send, `Shift+Enter` for a newline. Responses stream token-by-token.
- **Branching** — use **Regenerate** or **Edit** on any message to create a sibling branch. Navigate between siblings with `< 1/N >`.
- **Dual-model mode** — open thread settings, switch **Response mode** to **Dual model**, choose Model A/B, and pick **Cross review** or **Debate**. The chat shows the final synthesized answer first; the A/B answers, reviews, or debate turns are available in the collapsible **Dual-model details** block. This mode makes several LLM calls per message, so responses cost more and take longer than normal mode.
- **Attachments** — attach images (sent to vision-capable models), PDFs (text extracted), or text/code files (up to 10MB each).
- **Semantic search** — search across all threads; results are ranked by pgvector cosine similarity.
- **Web scraping** — when web search is enabled, results are scraped and ingested as a RAG source for the current answer.
- **Tor** — toggle Tor in settings for anonymous scraping.
- **Settings** — open the Settings panel to change the LLM provider/model, thinking effort, embedding model, web search count, and Tor options. Changes are written to `.env` and take effect immediately, except embedding-model changes which require a migration (see below).

## Database Migrations

UmansChat uses Drizzle ORM with pgvector. To apply migrations manually (e.g. on a fresh local database):

```bash
bunx drizzle-kit migrate
```

When you switch the embedding model (changing `EMBED_MODEL` / `EMBED_DIM`), the existing `embeddings` and `page_embeddings` vector columns must be recreated with the new dimension. Use the Settings GUI's migration action (`applyMigration`) to drop and recreate the vector columns, then re-embed your content.

## Testing

```bash
# Unit tests
bun run test

# Type checking
bun run typecheck

# Linting
bun run lint
```
