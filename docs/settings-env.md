Settings & Environment Configuration

> All runtime configuration in MinervaAIWorkspace lives in a single `.env` file at the project root. The in-app Settings GUI (Settings modal) reads and writes this file at runtime via `POST /api/settings` — no server restart is required for most settings.

## Relevant source files

- `src/lib/envUtils.ts` — `.env` path resolution, value escaping, read/update/write helpers
- `src/app/api/settings/route.ts` — `GET /api/settings` (read) and `POST /api/settings` (write) handlers
- `scripts/sync-env.ts` — pre-startup `.env` ↔ `.env.example` synchronization
- `.env.example` — canonical list of all environment variables with defaults and comments
- `docker-compose.yml` — Docker Compose-only environment overrides
- `docker-entrypoint.sh` — Docker container entrypoint (runs `sync-env` + migrations)
- `launcher/minerva-launcher.cjs` — standalone exe launcher (runs `sync-env` + migrations)

## Overview

MinervaAIWorkspace uses a flat `.env` file as its sole configuration source. The file is read at startup by `dotenv` (local dev / exe) or `env_file` in Docker Compose, and it is also writable at runtime through the Settings API.

### Two layers of configuration

| Layer | Where | Scope | Mutability |
|-------|-------|-------|------------|
| **Environment variables** (`.env`) | Project root `.env` | Process-wide | GUI / API / manual edit |
| **Per-user settings** (database) | `users` table | Per user | GUI only (saved to DB, not `.env`) |

Per-user settings — default global instruction selection (`activeInstructionId`) and personalization traits (`personalStyle`, `personalWarmth`, `personalEnergy`, `personalStructure`, `personalEmoji`) — are stored in the `users` table, not in `.env`. They are read and written by the same `GET`/`POST /api/settings` endpoints but follow a different persistence path. See [Personalization](./personalization.md).

### Runtime editing without restart

When a setting is changed via the Settings GUI, `POST /api/settings`:

1. Updates the `.env` file on disk (persisted across restarts).
2. Updates `process.env` in the current Node.js process (takes effect immediately).
3. Invalidates relevant in-process caches so the new value is used on the next request.

This means most configuration changes — LLM provider, model, API key, embedding model, web search parameters, scraper URLs, etc. — take effect without restarting the server.

## envUtils.ts — `.env` file manipulation

The `src/lib/envUtils.ts` module provides low-level helpers for locating, escaping, and writing `.env` values. It is used by `POST /api/settings` and can be imported anywhere that needs to programmatically update `.env`.

### `resolveEnvPath()`

```typescript
export function resolveEnvPath(): string
```

Searches **upward** from `process.cwd()` for an existing `.env` file, up to 10 parent directories. If found, returns the absolute path. If not found, falls back to `cwd/.env` (creating a new file if needed).

**Why upward search?** In the Next.js standalone server (Docker image), the server runs from `/app/.next/standalone` after `process.chdir()`. Writing directly under `cwd` would target a temporary path inside the ephemeral image layer. The upward search walks past the standalone directory to find the real `.env` mounted at `/app/.env` (Docker Compose binds `./.env:/app/.env`).

### `escapeEnvValue()`

```typescript
export function escapeEnvValue(value: string): string
```

Wraps all values in double quotes and escapes characters that could break `.env` parsing or enable injection:

- `\` → `\\` (backslash)
- `"` → `\"` (double quote)
- newline → `\n`
- carriage return → `\r`

**Purpose:** Prevents [dotenv injection](https://github.com/motdotla/dotenv#variable-expansion) — characters like `#`, `=`, spaces, and newlines are kept safely inside the double-quoted value so dotenv does not misinterpret them as comments, key separators, or line breaks. The dotenv parser interprets `\n` inside `"..."` as a literal newline, so the round-trip is lossless.

```typescript
escapeEnvValue("hello world")     // '"hello world"'
escapeEnvValue('a"b#c')           // '"a\"b#c"'
escapeEnvValue("line1\nline2")    // '"line1\nline2"'
escapeEnvValue("")               // '""'
```

### `updateEnvContent()`

```typescript
export function updateEnvContent(
  envContent: string,
  updates: Record<string, string>,
): string
```

Given the current `.env` file content as a string and a map of `KEY → value` updates, returns a new string with each key updated in place (if it exists) or appended at the end (if it does not). Values are escaped via `escapeEnvValue()` before writing.

The update uses a line-anchored regex (`^KEY=.*$` with the `m` flag) to match only complete key definitions, so partial key name matches (e.g., `LLM_MODEL` matching `LLM_FALLBACK_MODEL`) are avoided.

### `writeEnvUpdates()`

```typescript
export function writeEnvUpdates(updates: Record<string, string>): string
```

Convenience wrapper that combines the above:

1. Resolves the `.env` path via `resolveEnvPath()`.
2. Reads the current content (empty string if the file does not exist).
3. Calls `updateEnvContent()` to produce the new content.
4. Writes the result back to disk via `writeFileSync`.
5. Returns the resolved `.env` path.

## POST /api/settings — writing settings

`POST /api/settings` is the single endpoint that persists all application settings. It is called by the Settings modal in the frontend.

**Relevant source:** `src/app/api/settings/route.ts` (lines 204–416)

### Request flow

```
Client (Settings modal)
  │
  │  POST /api/settings  { llmApiKey, llmModel, embedModel, ... }
  ▼
getSessionUser()  ──── 401 if not authenticated
  │
  ▼
Validate input (ranges, formats)
  │
  ▼
Check embedding dimension change
  │  └─ If EMBED_DIM changed & applyMigration≠true → 409 (migration_required)
  │  └─ If EMBED_DIM changed & applyMigration=true → run migration
  ▼
Save per-user settings to DB (activeInstructionId, personalization)
  │
  ▼
Write all env settings to .env + process.env
  │
  ▼
Invalidate caches (LLM / embedding / scraper)
  │
  ▼
200 OK  { success: true, migrationApplied: boolean }
```

### Writing to `.env` and `process.env`

The handler builds a `Record<string, string>` of only the keys present in the request body (fields sent as `undefined` are skipped, preserving existing values). It then:

1. Reads the current `.env` content via `resolveEnvPath()` + `readFileSync`.
2. Calls `updateEnvContent()` to produce updated content.
3. Writes the result back with `writeFileSync`.
4. Mirrors each update into `process.env` so the current process picks up the new value immediately.

```typescript
// src/app/api/settings/route.ts (excerpt)
const updates: Record<string, string> = {};
// ... collect all defined fields ...
envContent = updateEnvContent(envContent, updates);
writeFileSync(envPath, envContent);

// Also reflect in process.env
for (const [key, value] of Object.entries(updates)) {
  process.env[key] = value;
}
```

### Secrets handling

The handler never returns secrets in plaintext. The `GET /api/settings` endpoint returns `has*` boolean flags instead of the actual secret values:

```typescript
// GET response (excerpt)
llmApiKey: "",                        // always empty
hasLlmApiKey: !!process.env.LLM_API_KEY,
notionClientSecret: "",
hasNotionClientSecret: !!process.env.NOTION_CLIENT_SECRET,
tunnelToken: "",
hasTunnelToken: !!process.env.TUNNEL_TOKEN,
```

On `POST`, the frontend sends a secret field only when the user enters a new value; when the field is omitted (`undefined`), the existing `.env` value is preserved. The Cloudflare Tunnel token has an additional safeguard: an empty string is explicitly ignored so the token is never accidentally cleared:

```typescript
if (body.tunnelToken !== undefined && body.tunnelToken !== "") {
  updates.TUNNEL_TOKEN = body.tunnelToken;
}
```

### Cache invalidation

After writing to `.env` and `process.env`, the handler invalidates in-process caches so the new settings take effect immediately:

| Setting changed | Cache invalidated | Effect |
|----------------|-------------------|--------|
| `LLM_API_KEY`, `LLM_MODEL`, `LLM_FALLBACK_MODEL`, `LLM_FALLBACK_TIMEOUT_MS` | `resetUmansModelsCache()` + `resetToolProbeCache()` | LLM client recreated on next request; tool availability re-probed |
| `EMBED_MODEL`, `EMBED_DIM`, `EMBED_PROVIDER` | `resetEmbedPipeline()` | transformers.js / HTTP embedder pipeline recreated on next embed |
| `SCRAPE_PROXY`, `SCRAPE_TIMEOUT` | POST to scraper `/config` endpoint | Scraper microservice updated at runtime (its container env is fixed at compose startup) |

**LLM cache reset** (`src/lib/llm.ts`): `resetUmansModelsCache()` drops the cached OpenAI-compatible client and model list. `resetToolProbeCache()` (`src/lib/toolProbe.ts`) clears cached tool-availability results so they are re-evaluated against the new model.

**Embedding pipeline reset** (`src/lib/embed.ts`): `resetEmbedPipeline()` disposes the cached transformers.js `pipeline` (local ONNX) or the HTTP embedder client. The next call to `embedText()` lazily recreates the pipeline with the new `EMBED_MODEL` / `EMBED_PROVIDER`.

**Scraper runtime update**: The scraper container's environment variables are fixed at Docker Compose startup, so in-process values are pushed via a POST to `{SCRAPER_URL}/config`:

```typescript
fetch(`${scraperBase}/config`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    scrape_proxy: process.env.SCRAPE_PROXY ?? "",
    scrape_timeout: Number(process.env.SCRAPE_TIMEOUT) || 30,
  }),
}).catch(() => {
  // .env / process.env already updated; scraper picks up on next /config call
});
```

If the scraper is temporarily unreachable, the `.env` and `process.env` values are still persisted — the scraper reads them from `.env` on its next startup or `/config` call.

## Embedding model migration

When the embedding model dimension (`EMBED_DIM`) changes, existing vector data becomes invalid because different models produce incompatible vector spaces. MinervaAIWorkspace handles this with a two-phase confirmation gate.

### Dimension change detection

The handler reads the current dimension from `process.env.EMBED_DIM` (default `1024`) and compares it to the requested `embedDim`:

```typescript
const dbVectorDim = getEmbedDim();  // Number(process.env.EMBED_DIM) || 1024
const newDim = body.embedDim ?? dbVectorDim;
const needsMigration = body.embedDim !== undefined && body.embedDim !== dbVectorDim;
```

In SQLite, embeddings are stored as JSON arrays in `TEXT` columns, so no column DDL is needed for dimension changes — the schema is flexible. However, vectors from different model spaces cannot be compared, so all existing embedding data must be cleared or regenerated.

### Confirmation gate (HTTP 409)

If `embedDim` has changed but `applyMigration` is not `true`, the handler returns a **409 Conflict** with a structured error:

```json
{
  "error": "migration_required",
  "message": "Embedding dimension is changing from 1024 to 384. Existing memories and page embeddings will be deleted, and skills will be re-embedded. Send applyMigration=true to confirm.",
  "currentDim": 1024,
  "newDim": 384
}
```

The frontend Settings modal displays this message and asks the user to confirm before re-submitting with `applyMigration: true`.

### Migration execution

When `applyMigration: true` is sent alongside a dimension change, the handler executes the migration **before** writing to `.env`:

1. **Update `process.env` first** — sets `EMBED_MODEL`, `EMBED_DIM`, and `EMBED_PROVIDER` so that `embedText()` references the new model when re-embedding.

2. **Reset the embedding pipeline** — calls `resetEmbedPipeline()` to drop the old model and load the new one.

3. **Delete regenerable data:**
   - `memories` table — all rows deleted (memories are extracted from conversations and can be regenerated).
   - `page_embeddings` table — all rows deleted (page embeddings are regenerated from cached page content on next scrape).

4. **Re-embed persistent data:**
   - `skills` table — skills are user-created persistent prompts that are **not** deleted. Each skill's `content` is re-embedded with the new model and the `embedding` column is updated:

   ```typescript
   const allSkills = await db.select({ id: skills.id, content: skills.content }).from(skills);
   for (const skill of allSkills) {
     const vector = await embedText(skill.content, "document");
     await db.update(skills).set({ embedding: vector }).where(eq(skills.id, skill.id));
   }
   ```

5. After migration, the handler continues with the normal flow — writing all settings to `.env` and invalidating caches.

> **Note:** The migration updates `process.env` before writing `.env` so that `embedText()` uses the new model during re-embedding. The `.env` file is written afterward in the normal save flow, ensuring the change persists across restarts.

See [Embeddings & Vector Search](./embeddings.md) for details on the embedding pipeline and vector storage.

## sync-env.ts — pre-startup `.env` synchronization

`scripts/sync-env.ts` ensures that `.env` contains every key defined in `.env.example`. It runs before the server starts, appending any missing keys with their example values.

### When it runs

| Environment | Invocation |
|-------------|------------|
| Local dev | `package.json` `predev` script: `bun run scripts/sync-env.ts` (runs before `next dev`) |
| Docker | `docker-entrypoint.sh`: `node --experimental-strip-types /app/scripts/sync-env.ts` |
| Standalone exe | `launcher/minerva-launcher.cjs` (runs sync-env before migrations + server start) |

### How it works

```typescript
export function syncEnv(examplePath: string, envPath: string, now: Date = new Date()): string[]
```

1. **Parse `.env.example`** — extracts a `Map<KEY, value>` using a minimal parser (skips `#` comments, extracts `KEY=value`, strips surrounding `"..."` quotes).

2. **Check each key** — uses `hasKey()` to test whether `.env` already contains the key. Both active definitions (`^KEY=`) and commented-out definitions (`^# KEY=`) count as existing, so a key the user intentionally commented out is not re-appended.

3. **Append missing keys** — collects all keys not found in `.env` and appends them at the end with a header comment:

   ```env
   # Auto-merged from .env.example (2026-01-15T00:00:00.000Z)
   NEW_KEY=default-value
   ```

4. **Never modifies existing keys** — existing values are preserved exactly as-is, even if they differ from the example defaults.

### Why it exists

As MinervaAIWorkspace evolves, new environment variables are added to `.env.example`. Without sync-env, users upgrading would miss new required keys, causing runtime errors. The script is idempotent — running it repeatedly has no effect once `.env` is up to date.

```text
[sync-env] .env is up to date.
```

If `.env.example` is not found (edge case), the script logs a message and skips:

```text
[sync-env] No .env.example found. Skipping.
```

## Full environment variable reference

All variables below are defined in `.env.example`. Values shown are defaults from that file. Variables marked **required** must be set before the app can function; others are optional or have sensible defaults.

### LLM (UmansAI — hardcoded provider)

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_API_KEY` | `your-api-key-here` | **Required.** API key for UmansAI. Never returned in plaintext by the API. |
| `LLM_MODEL` | `umans-glm-5.2` | Default model used for chat completions. |
| `THINKING_EFFORT` | `medium` | LLM reasoning strength. Accepts `none`, `low`, `medium`, `high`, `max` (support varies per model). |
| `WEB_SEARCH_THINKING_EFFORT` | `none` | Reasoning strength for search result summarization. Same levels as `THINKING_EFFORT`. |

### Embeddings

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model identifier. `local` = transformers.js ONNX model; `http` = Python embedder service model name. |
| `EMBED_DIM` | `384` | Vector dimension of the embedding model. Must match the model's output dimension. Changing this triggers a migration — see [Embedding model migration](#embedding-model-migration). |
| `EMBED_PROVIDER` | `local` | `local` = transformers.js (runs in-process, no external service). `http` = Python embedder microservice (Docker only). |
| `EMBEDDER_URL` | `http://localhost:8001` | URL of the Python embedder service. Only used when `EMBED_PROVIDER=http`. Docker Compose sets this automatically. |

> **Default config:** `.env.example` defaults to local ONNX (`Xenova/all-MiniLM-L6-v2`, dim 384) so the app works without external services. Docker Compose overrides this to use the HTTP embedder (`LiquidAI/LFM2.5-Embedding-350M`, dim 1024) via the compose environment block. See [Embeddings & Vector Search](./embeddings.md).

### Web search

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_SEARCH_MODEL` | `umans-qwen3.6-35b-a3b` | Model used for web search query generation and result summarization. Must be alphanumeric (`[a-zA-Z0-9._-]+`). |
| `WEB_SEARCH_MAX_RESULTS` | `3` | Maximum number of search results per round. Range: 1–20. |
| `WEB_SEARCH_MAX_ROUNDS` | `3` | Maximum number of search queries executed per response (1–5). Caps how many of the query-generator's queries run. Each query carries its own `time_range` (per-query, from the LLM query generator) that overrides the global UI toggle when non-null. Language is chosen per query from the query text (CJK → `ja-JP`, else `en-US`). |

### Scraper & SearXNG

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRAPER_URL` | *(empty)* | URL of the Scrapling FastAPI scraper microservice. Empty = disabled in standalone mode (chat still works). Docker Compose sets this to `http://scraper:8000`. |
| `SEARXNG_URL` | *(empty)* | URL of the SearXNG meta-search instance. Empty = disabled in standalone mode. Docker Compose sets this to `http://searxng:8080`. |
| `SCRAPE_TIMEOUT` | `30` | Timeout in seconds for scraping a single page. Read by the scraper container. Changing this via the GUI pushes the update to the scraper at runtime via its `/config` endpoint. |
| `SEARXNG_LANGUAGE` | *(auto)* | BCP47 language tag passed to SearXNG's `language` param (e.g. `ja-JP`, `en-US`). Chosen **per search query** from the query text (CJK characters → `ja-JP`, otherwise `en-US`); not set via `.env`. When `None`, SearXNG uses auto-locale detection. |

### Tor proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `TOR_PROXY` | *(empty)* | Tor SOCKS proxy URL for anonymous web requests (e.g., `socks5://localhost:9050`). Empty = disabled. |
| `SCRAPE_PROXY` | *(empty)* | Proxy URL used by the scraper for all requests. Empty = direct connection. Often set to the Tor proxy URL. Changing this via the GUI pushes the update to the scraper at runtime. |

### Database & runtime

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `data/minerva.db` | SQLite database file path (relative to app root or absolute). Standalone exe creates `data/minerva.db` on first run. See [Database & Schema](./database.md). |
| `HOST_OS` | *(empty)* | Operating system label injected into LLM prompts (`Windows` / `macOS` / `Linux`). Empty = auto-detect from `/proc/version`. |
| `TZ` | *(empty)* | Timezone for date/time in LLM prompts. Empty defaults to `Asia/Tokyo`. |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_SECRET` | *(empty)* | **Required.** Secret used to sign JWT sessions. Generate with `bunx auth secret`. See [Authentication & User Isolation](./authentication.md). |
| `AUTH_TRUST_HOST` | `true` | Whether to trust the `Host` header for Auth.js. Set to `true` in most deployments. |
| `AUTH_URL` | `http://localhost:3001` | Public URL of the app. Must match the redirect URI configured in Notion and Google OAuth. For Cloudflare Tunnel, set to the tunnel's HTTPS URL. Read per-request by Auth.js. |

### Notion OAuth (Connections)

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTION_CLIENT_ID` | *(empty)* | Notion OAuth client ID. Create a public integration at [notion.so/developers](https://www.notion.so/developers). Redirect URI: `{AUTH_URL}/api/connections/notion/callback`. |
| `NOTION_CLIENT_SECRET` | *(empty)* | Notion OAuth client secret. Never returned in plaintext by the API. |

### Google OAuth (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` | *(empty)* | Google OAuth client ID. Create credentials at [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Redirect URI: `{AUTH_URL}/api/auth/callback/google`. |
| `GOOGLE_CLIENT_SECRET` | *(empty)* | Google OAuth client secret. Conditionally included as a provider when env vars are set. |

### Cloudflare Tunnel (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `TUNNEL_TOKEN` | *(empty)* | Cloudflare named tunnel token. Create a tunnel at [one.dash.cloudflare.com](https://one.dash.cloudflare.com). Route to `Service=http://app:3000`. Run with `docker compose --profile tunnel up -d`. Never returned in plaintext by the API. Empty strings are ignored on save to prevent accidental clearing. |

## Docker Compose-only environment variables

These variables are **not** in `.env.example` — they are set only in `docker-compose.yml` environment blocks and control Docker-specific behavior. They are not editable via the Settings GUI.

| Variable | Where set | Default | Description |
|----------|-----------|---------|-------------|
| `SCRAPER_URL` | `docker-compose.yml` (app service) | `http://scraper:8000` | Overridden to the Docker internal network address. (Also settable in `.env` for standalone mode.) |
| `SEARXNG_URL` | `docker-compose.yml` (app service) | `http://searxng:8080` | Overridden to the Docker internal network address. |
| `EMBEDDER_URL` | `docker-compose.yml` (app service) | `http://embedder:8001` | Set automatically to the embedder container address. |
| `AUTH_TRUST_HOST` | `docker-compose.yml` (app service) | `"true"` | Hardcoded to `"true"` in Docker. |
| `SCRAPE_TIMEOUT` | `docker-compose.yml` (scraper service) | `30` | Timeout passed to the scraper container. Falls back to `30` if unset in `.env`. |
| `EMBEDDER_MODEL` | `docker-compose.yml` (embedder service) | `LiquidAI/LFM2.5-Embedding-350M` | Model loaded by the Python embedder service. Separate from `EMBED_MODEL` (which is what the app sends to / receives from the embedder). |
| `EMBEDDER_GPU_COUNT` | `docker-compose.yml` (embedder service) | `0` | Number of NVIDIA GPUs to reserve for the embedder. `0` = CPU fallback (safe with Docker Compose v2.18+). |
| `TUNNEL_TOKEN` | `docker-compose.yml` (cloudflared service) | *(empty)* | Passed to the `cloudflared` container. Activated with `--profile tunnel`. |
| `SEARXNG_BASE_URL` | `docker-compose.yml` (searxng service) | `http://searxng:8080` | SearXNG's own base URL for internal service discovery. |
| `TORPASSWORD` | `docker-compose.yml` (tor service) | `minerva-tor-control` | Tor control port password for the `dperson/torproxy` container. |
| `MINERVA_APP_IMAGE` | `docker-compose.yml` (app service) | `ghcr.io/johmaru/minerva-ai-workspace-app:latest` | Override the app image (e.g., for pinning a version). |
| `MINERVA_SCRAPER_IMAGE` | `docker-compose.yml` (scraper service) | `ghcr.io/johmaru/minerva-ai-workspace-scraper:latest` | Override the scraper image. |
| `MINERVA_EMBEDDER_IMAGE` | `docker-compose.yml` (embedder service) | `ghcr.io/johmaru/minerva-ai-workspace-embedder:latest` | Override the embedder image. |

> **Note on `SCRAPER_URL` / `SEARXNG_URL` / `EMBEDDER_URL`:** These appear in both `.env.example` (for standalone mode, where they may be empty/disabled) and `docker-compose.yml` (where they are set to Docker internal network addresses). In Docker, the compose `environment` block takes precedence over `env_file` for the same key, so the Docker internal addresses win. The `.env` values are still used when running standalone (exe or `bun dev`).

See [Deployment](./deployment.md) for the full Docker Compose service topology and standalone exe packaging.

## See also

- [Database & Schema](./database.md) — SQLite setup, the `users` table (per-user settings), migrations
- [Embeddings & Vector Search](./embeddings.md) — embedding pipeline, vector storage, dimension migration details
- [Deployment](./deployment.md) — Docker Compose topology, standalone exe, CI/CD, Cloudflare Tunnel
- [Authentication & User Isolation](./authentication.md) — Auth.js v5, JWT sessions, OAuth providers
- [Personalization](./personalization.md) — per-user style presets and trait sliders (saved to DB, not `.env`)
- [API Routes Reference](./api-routes.md) — full reference for `GET`/`POST /api/settings` and all other endpoints
