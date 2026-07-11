Database and schema reference for the UmansChat backend — SQLite, Drizzle ORM, connection setup, full table/index reference, and migrations.

## Relevant source files

- `src/db/schema.ts` — Drizzle table definitions (source of truth for this doc)
- `src/db/index.ts` — connection singleton, PRAGMAs, integrity check, corruption recovery
- `drizzle.config.ts` — drizzle-kit configuration
- `drizzle/*.sql` — generated migration files
- `docker-entrypoint.sh` — migration runner for Docker
- `launcher/umanschat-launcher.cjs` — migration runner for the standalone exe
- `package.json` — `predev` hook (local-dev migration runner)
- `vitest.setup.ts` — programmatic migrator used by the test suite

## Stack

UmansChat uses **SQLite** via the [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) synchronous native driver, accessed through the **[Drizzle ORM](https://orm.drizzle.team/)** (`drizzle-orm/better-sqlite3`).

- **Driver:** `better-sqlite3` — a synchronous, native C++ binding. Calls block the Node.js event loop, which is fine for a single-user chat application.
- **ORM:** Drizzle — lightweight, type-safe, SQL-first. The schema is defined in TypeScript (`src/db/schema.ts`) and Drizzle generates SQL migrations with `drizzle-kit`.
- **DB file:** `data/umanschat.db` (a single file on disk; the `data/` directory is created automatically on first launch). Overridable via the `DATABASE_URL` environment variable.

No external database server is required. There is no pgvector extension and no HNSW index — embeddings are stored as JSON text and cosine similarity is computed in application code (see [Embedding storage](#embedding-storage)).

## Connection setup

### Singleton pattern

`src/db/index.ts` exports a single shared `db` instance. To avoid opening multiple connections during Next.js hot-module reloading in development, the underlying `better-sqlite3` handle and the Drizzle wrapper are cached on `globalThis`:

```ts
// src/db/index.ts (simplified)
const globalForDb = globalThis as unknown as { sqlite?: Database.Database; db?: Db };

const dbPath = process.env.DATABASE_URL || join(process.cwd(), "data", "umanschat.db");
mkdirSync(dirname(dbPath), { recursive: true }); // create data/ on first launch

const sqlite = globalForDb.sqlite ?? openDatabase(dbPath);
if (process.env.NODE_ENV !== "production") {
  globalForDb.sqlite = sqlite;
}

export const db: Db = globalForDb.db ?? drizzle(sqlite, { schema });
if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
```

The `data/` directory is created with `mkdirSync(..., { recursive: true })` before the database is opened, so a first launch on a fresh checkout works without manual setup.

### PRAGMAs

Every database handle (fresh, recovered, or test) has these PRAGMAs applied on open:

| PRAGMA | Value | Purpose |
|--------|-------|---------|
| `journal_mode` | `DELETE` | Rollback-journal mode (see below) |
| `synchronous` | `NORMAL` | Good balance of durability and speed for a single-user app |
| `foreign_keys` | `ON` | Enforce FK `ON DELETE` actions (`cascade`, `set null`) |

### Why `journal_mode = DELETE` (not WAL)

WAL (Write-Ahead Logging) mode requires an mmap'd `-shm` file shared across processes. **Docker Desktop on Windows bind mounts do not handle the file-sharing layer's mmap correctly**, which produces a corrupted (often 3-byte) `-shm` file and ultimately a `SQLITE_CORRUPT` error.

`DELETE` mode uses a regular `-journal` rollback file and works correctly on bind mounts. The trade-off — read/write blocking (concurrent readers block a writer and vice versa) — is irrelevant for a single-user chat application with one connection.

The Docker entrypoint additionally removes stale `*.db-wal` and `*.db-shm` sidecars on every start, in case an older WAL-mode setup left them behind (a truncated `-shm` can confuse the first open).

### Integrity check on open

`openDatabase()` runs a read-only probe before reopening the database in read-write mode:

1. Open the file **read-only** with `fileMustExist: true`.
2. Run `PRAGMA integrity_check`.
3. If the result is `"ok"`, close the probe and reopen in read-write mode with PRAGMAs.
4. If the check fails (or the file isn't a valid SQLite database — `SQLITE_NOTADB`), proceed to [corruption recovery](#corruption-recovery).

The read-only probe exists because of a Windows-specific `better-sqlite3` quirk: when the constructor opens a corrupted database in read-write mode it may throw **without releasing the native file handle**. If the handle remains, the subsequent `renameSync` in recovery fails with `EBUSY` and the backup cannot be moved aside. Opening read-only first reliably releases the handle on `close()`.

### Corruption recovery

`recoverDatabase()` runs when the integrity check fails or the file is not a valid SQLite database. It is designed to be a **fast no-op for a healthy database** and a best-effort healer for a damaged one:

1. **Back up** the corrupt file: `renameSync(dbPath, dbPath + ".corrupt-<timestamp>")`.
2. **Delete sidecars** (`-wal`, `-shm`, `-journal`) left over from the old file.
3. **Recover** via the `sqlite3` CLI: `sqlite3 "<backup>" ".recover" | sqlite3 "<newdb>"`. The `.recover` command dumps salvageable data as SQL text, which is piped into a fresh binary database. This reconstructs a valid SQLite file even when pages are damaged.
4. If the backup file is **not** a real SQLite file (e.g. a deployed bug once wrote raw SQL text to `dbPath`), `findRealBackup()` searches for a previous `*.corrupt-*` backup that has a valid SQLite magic header and recovers from that instead.
5. **Fall back to fresh** if recovery fails entirely: create an empty database file and let migrations rebuild the schema. Data is lost, but the app boots.
6. The recovered (or fresh) handle gets the standard PRAGMAs and a warning is logged.

The `sqlite3` CLI must be available on `PATH` for `.recover` to work (it ships with most systems and inside the Docker image). If it is missing, recovery falls back to a fresh empty database.

## Full table reference

All tables are defined in `src/db/schema.ts`. Timestamps use a shared helper: `integer(name, { mode: "timestamp_ms" })` — stored as Unix epoch milliseconds, read/written as JS `Date` objects. Primary keys are `text` UUIDs generated with `randomUUID()`.

### `global_instructions`

Per-user named global system instructions. Multiple can be created; the active one is selected via `users.activeInstructionId` and can be overridden per-thread via `threads.globalInstructionId`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `user_id` | text NOT NULL | FK → `users.id`, `ON DELETE CASCADE` |
| `name` | text NOT NULL | |
| `content` | text NOT NULL | |
| `created_at` | integer NOT NULL | timestamp_ms, default now |
| `updated_at` | integer NOT NULL | timestamp_ms, default now |

### `users`

Application users. Authenticate via email/password (Credentials) or Google OAuth. The first user to register inherits any pre-existing ownerless threads/folders.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `nickname` | text NOT NULL | |
| `email` | text NOT NULL, UNIQUE | login identifier |
| `password_hash` | text | bcrypt hash; null for OAuth-only users |
| `active_instruction_id` | text | (unreferenced FK) selected `global_instructions.id` |
| `personal_style` | text | null disables personalization |
| `personal_warmth` | integer NOT NULL, default 1 | |
| `personal_energy` | integer NOT NULL, default 1 | |
| `personal_structure` | integer NOT NULL, default 1 | |
| `personal_emoji` | integer NOT NULL, default 1 | |
| `name` | text | OAuth `name` (written by DrizzleAdapter) |
| `email_verified` | integer | timestamp_ms |
| `image` | text | OAuth avatar URL |
| `created_at` | integer NOT NULL | timestamp_ms, default now |

### `accounts`

OAuth/OIDC account links, managed by Auth.js `DrizzleAdapter`. One row per `(provider, providerAccountId)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `user_id` | text NOT NULL | FK → `users.id`, `CASCADE` |
| `type` | text | `oauth` / `oidc` / `email` |
| `provider` | text NOT NULL | e.g. `google` |
| `provider_account_id` | text NOT NULL | |
| `access_token` | text | |
| `refresh_token` | text | |
| `expires_at` | integer | timestamp_ms |
| `token_type` | text | |
| `scope` | text | |
| `id_token` | text | |

### `sessions`

Auth.js session records (database-session mode). UmansChat uses a JWT session strategy, so this table is defined for compatibility but the JWT is the source of truth at runtime.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `user_id` | text NOT NULL | FK → `users.id`, `CASCADE` |
| `expires` | integer NOT NULL | timestamp_ms |
| `session_token` | text NOT NULL, UNIQUE | |

### `verification_tokens`

Email verification tokens (Auth.js adapter contract). No primary key.

| Column | Type | Notes |
|--------|------|-------|
| `identifier` | text NOT NULL | typically the email |
| `token` | text NOT NULL | |
| `expires` | integer NOT NULL | timestamp_ms |

### `skills`

Per-user reusable procedures/rules, extracted from conversations and stored with embeddings. Searched via client-side cosine similarity and injected into system context. See [Skills System](./skills.md).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `user_id` | text NOT NULL | FK → `users.id`, `CASCADE` |
| `name` | text NOT NULL | |
| `content` | text NOT NULL | |
| `embedding` | text NOT NULL (JSON) | `number[]` — see [Embedding storage](#embedding-storage) |
| `content_hash` | text NOT NULL | change detection |
| `kind` | text NOT NULL, default `workflow` | enum: `workflow`, `bugfix`, `project_rule`, `tool_usage`, `coding_pattern`, `debugging` |
| `trigger` | text | natural-language trigger |
| `tags` | text NOT NULL (JSON), default `[]` | `string[]` |
| `scope` | text NOT NULL, default `global` | enum: `global`, `folder`, `thread` |
| `status` | text NOT NULL, default `active` | enum: `active`, `archived` |
| `version` | integer NOT NULL, default 1 | |
| `source_thread_id` | text | FK → `threads.id`, `ON DELETE SET NULL` |
| `source_message_ids` | text (JSON) | `string[]` |
| `last_used_at` | integer | timestamp_ms |
| `success_count` | integer NOT NULL, default 0 | |
| `failure_count` | integer NOT NULL, default 0 | |
| `created_at` | integer NOT NULL | timestamp_ms, default now |
| `updated_at` | integer NOT NULL | timestamp_ms, default now |

### `skill_candidates`

Skill proposals automatically extracted from conversations. Remain as `draft` until the user approves/rejects them; on approval they are promoted to the `skills` table.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `user_id` | text NOT NULL | FK → `users.id`, `CASCADE` |
| `thread_id` | text | FK → `threads.id`, `CASCADE` |
| `source_message_ids` | text (JSON) | `string[]` |
| `proposed_name` | text NOT NULL | |
| `proposed_kind` | text NOT NULL | enum (same as `skills.kind`) |
| `proposed_trigger` | text NOT NULL | |
| `proposed_content` | text NOT NULL | |
| `proposed_tags` | text NOT NULL (JSON), default `[]` | `string[]` |
| `confidence` | real NOT NULL, default 0.5 | |
| `reason` | text | |
| `status` | text NOT NULL, default `draft` | enum: `draft`, `approved`, `rejected`, `merged` |
| `created_at` | integer NOT NULL | timestamp_ms, default now |
| `updated_at` | integer NOT NULL | timestamp_ms, default now |

### `skill_usage_events`

Audit log of skill activations (semantic search match or manual invocation). Used for feedback (`outcome`) and analytics (`success_count`/`failure_count` rollups).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `skill_id` | text NOT NULL | FK → `skills.id`, `CASCADE` |
| `user_id` | text NOT NULL | FK → `users.id`, `CASCADE` |
| `thread_id` | text NOT NULL | FK → `threads.id`, `CASCADE` |
| `message_id` | text | |
| `similarity` | real | cosine score for semantic activations |
| `activation_type` | text NOT NULL | enum: `semantic`, `manual` |
| `outcome` | text NOT NULL, default `unknown` | enum: `unknown`, `helpful`, `not_helpful` |
| `created_at` | integer NOT NULL | timestamp_ms, default now |

### `mcp_servers`

Per-user MCP (Model Context Protocol) server connection definitions. Enabled/disabled per thread via `threads.mcp_server_ids`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `user_id` | text NOT NULL | FK → `users.id`, `CASCADE` |
| `name` | text NOT NULL | |
| `transport` | text NOT NULL | enum: `http`, `stdio` |
| `url` | text | for `http` (Streamable HTTP / SSE fallback) |
| `command` | text | for `stdio` |
| `args` | text (JSON) | `string[]` for `stdio` |
| `env` | text (JSON) | `Record<string, string>` for `stdio` |
| `created_at` | integer NOT NULL | timestamp_ms, default now |
| `updated_at` | integer NOT NULL | timestamp_ms, default now |

### `connections`

External services OAuth-authorized by the user (e.g. Notion). The `provider` enum is extensible (currently only `notion`). Enabled/disabled per thread via `threads.connection_ids`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `user_id` | text NOT NULL | FK → `users.id`, `CASCADE` |
| `provider` | text NOT NULL | enum: `notion` |
| `access_token` | text NOT NULL | only for rows with obtained tokens |
| `refresh_token` | text NOT NULL | |
| `workspace_name` | text | display metadata |
| `workspace_icon` | text | display metadata |
| `bot_id` | text | |
| `owner_name` | text | display metadata |
| `owner_email` | text | display metadata |
| `created_at` | integer NOT NULL | timestamp_ms, default now |
| `updated_at` | integer NOT NULL | timestamp_ms, default now |

### `threads`

Conversation threads. `current_leaf_id` tracks the currently displayed branch in the branching message tree.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `title` | text NOT NULL, default `New chat` | |
| `system_prompt` | text | per-thread override |
| `model` | text NOT NULL, default `umans-glm-5.2` | |
| `response_mode` | text NOT NULL, default `single` | enum: `single`, `dual` |
| `dual_model_a` | text | for `dual` mode |
| `dual_model_b` | text | for `dual` mode |
| `dual_strategy` | text NOT NULL, default `cross_review` | enum: `cross_review`, `debate` |
| `dual_debate_rounds` | integer NOT NULL, default 2 | |
| `mcp_server_ids` | text NOT NULL (JSON), default `[]` | `string[]` |
| `folder_id` | text | FK → `folders.id`, `ON DELETE SET NULL` |
| `connection_ids` | text NOT NULL (JSON), default `[]` | `string[]` |
| `global_instruction_id` | text | FK → `global_instructions.id`, `ON DELETE SET NULL` |
| `current_leaf_id` | text | leaf message id of the displayed branch |
| `temperature` | real | added in migration 0002 |
| `max_tokens` | integer | added in migration 0002 |
| `context_length` | integer | added in migration 0002 |
| `auto_compact` | integer | added in migration 0002 |
| `user_id` | text | FK → `users.id`, `CASCADE` |
| `created_at` | integer NOT NULL | timestamp_ms, default now |
| `updated_at` | integer NOT NULL | timestamp_ms, default now |

### `folders`

Group threads. `instruction` is prepended to member threads' system prompts. When `memory_scope` is `folder`, conversation-memory (RAG) search is limited to threads in the same folder; `global` (default) searches across all threads. Hierarchy is one level only — no self-reference.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `name` | text NOT NULL, default `New folder` | |
| `instruction` | text | prepended to member thread system prompts |
| `memory_scope` | text NOT NULL, default `global` | enum: `folder`, `global` |
| `user_id` | text | FK → `users.id`, `CASCADE` |
| `created_at` | integer NOT NULL | timestamp_ms, default now |
| `updated_at` | integer NOT NULL | timestamp_ms, default now |

### `messages`

Branching message tree. `parent_id` is NULL for the thread root; edits/regenerations create a new row linked to the parent (ChatGPT-style branching). Old branches are retained.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `thread_id` | text NOT NULL | FK → `threads.id`, `CASCADE` |
| `parent_id` | text | self-referencing; NULL for root |
| `role` | text NOT NULL | enum: `user`, `assistant`, `system` |
| `content` | text NOT NULL | |
| `reasoning` | text | assistant thought process (collapsible display) |
| `metadata` | text (JSON) | dual-response traces, model info, timing |
| `created_at` | integer NOT NULL | timestamp_ms, default now |

### `memories`

Conversation memories (`fact` or `working`). After an assistant response completes, the conversation is summarized/classified via LLM and stored with an embedding. On the next send, client-side cosine search → recency-sorted → top-5 injected into system context (RAG). See [Memory System](./memory.md).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `thread_id` | text NOT NULL | FK → `threads.id`, `CASCADE` |
| `folder_id` | text | FK → `folders.id`, `ON DELETE SET NULL` |
| `kind` | text NOT NULL | enum: `fact`, `working` |
| `content` | text NOT NULL | |
| `source_message_ids` | text (JSON) | `string[]` |
| `embedding` | text NOT NULL (JSON) | `number[]` — see [Embedding storage](#embedding-storage) |
| `content_hash` | text NOT NULL | dedup/change detection |
| `model` | text NOT NULL | embedding model that produced the vector |
| `importance` | real NOT NULL, default 0.5 | |
| `suppressed_at` | integer | timestamp_ms; soft delete (invalidates on replace/merge) |
| `created_at` | integer NOT NULL | timestamp_ms, default now |
| `updated_at` | integer NOT NULL | timestamp_ms, default now |


### `user_traits`

Persistent user profile traits (always injected, not similarity-searched). Extracted alongside memories via a shared LLM call (`kind: "profile"`). Stored with embeddings for dedup (`cosine > 0.85`) and contradiction candidate selection (`cosine > 0.75`). See [Memory System → User Traits](./memory.md#user-traits-profile).

Unlike `memories`, these are user-scoped (direct `userId` FK, not thread-scoped) and survive thread deletion (`source_thread_id` is `ON DELETE SET NULL`).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `user_id` | text NOT NULL | FK → `users.id`, `CASCADE` |
| `category` | text NOT NULL | enum: `demographic`, `interest`, `speech_pattern`, `preference` |
| `content` | text NOT NULL | |
| `embedding` | text NOT NULL (JSON) | `number[]` — used for dedup + contradiction, NOT for retrieval |
| `content_hash` | text NOT NULL | SHA-256, exact dedup |
| `model` | text NOT NULL | embedding model that produced the vector |
| `confidence` | real NOT NULL, default 0.5 | increases with repeated evidence (+0.15 per observation, max 1.0) |
| `evidence_count` | integer NOT NULL, default 1 | how many times this trait was observed |
| `suppressed_at` | integer | timestamp_ms; soft delete (user delete or contradiction) |
| `source_thread_id` | text | FK → `threads.id`, `ON DELETE SET NULL` (trait survives thread deletion) |
| `source_message_ids` | text (JSON) | `string[]` |
| `created_at` | integer NOT NULL | timestamp_ms, default now |
| `updated_at` | integer NOT NULL | timestamp_ms, default now |

### `attachments`

Files attached to messages. Images are stored as base64 dataURLs (passed inline to vision models); PDF/text files have text extracted server-side into `extracted_text`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `thread_id` | text NOT NULL | FK → `threads.id`, `CASCADE` |
| `message_id` | text | FK → `messages.id`, `CASCADE` |
| `filename` | text NOT NULL | |
| `mime_type` | text NOT NULL | |
| `data_url` | text | base64 dataURL for images |
| `extracted_text` | text | extracted text for PDF/text |
| `created_at` | integer NOT NULL | timestamp_ms, default now |

### `pages`

Permanent knowledge from scraped web pages. One row per URL; if `content_hash` matches, a re-fetch is skipped. Feeds cross-thread RAG/search via `page_embeddings`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `url` | text NOT NULL, UNIQUE | |
| `url_hash` | text NOT NULL, UNIQUE | SHA-256 of normalized URL; fetch-cache check |
| `title` | text | |
| `content` | text NOT NULL | |
| `content_hash` | text NOT NULL | SHA-256 of content; change detection |
| `fetched_at` | integer NOT NULL | timestamp_ms, default now |
| `status` | integer NOT NULL, default 200 | HTTP status of last fetch |
| `error_message` | text | |

### `page_embeddings`

Embedding vectors for `pages` body text. Same dimensionality as `memories.embedding`. Cosine similarity computed in `vectorSearch.ts`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `page_id` | text NOT NULL | FK → `pages.id`, `CASCADE` |
| `content_hash` | text NOT NULL | invalidates embedding when page content changes |
| `embedding` | text NOT NULL (JSON) | `number[]` — see [Embedding storage](#embedding-storage) |
| `model` | text NOT NULL | embedding model that produced the vector |
| `created_at` | integer NOT NULL | timestamp_ms, default now |

## Indexes reference

| Index name | Table | Column(s) | Type | Purpose |
|------------|-------|-----------|------|---------|
| `users_email_unique` | `users` | `email` | unique | login lookup, prevents duplicate emails |
| `accounts_provider_unique` | `accounts` | `provider, provider_account_id` | unique | Auth.js upsert contract |
| `sessions_session_token_unique` | `sessions` | `session_token` | unique | session lookup |
| `pages_url_unique` | `pages` | `url` | unique | one row per URL |
| `pages_url_hash_unique` | `pages` | `url_hash` | unique | fetch-cache check |
| `pages_url_hash_idx` | `pages` | `url_hash` | normal | fast `url_hash` lookup |
| `messages_thread_idx` | `messages` | `thread_id` | normal | load a thread's messages |
| `messages_parent_idx` | `messages` | `parent_id` | normal | branching-tree traversal |
| `memories_thread_idx` | `memories` | `thread_id` | normal | filter memories by thread |
| `memories_folder_idx` | `memories` | `folder_id` | normal | folder-scoped RAG search |
| `memories_kind_idx` | `memories` | `kind` | normal | filter fact vs working |
| `memories_suppressed_idx` | `memories` | `suppressed_at` | normal | exclude soft-deleted rows |
| `attachments_message_idx` | `attachments` | `message_id` | normal | load a message's attachments |
| `attachments_thread_idx` | `attachments` | `thread_id` | normal | list thread attachments |
| `page_embeddings_page_idx` | `page_embeddings` | `page_id` | normal | load a page's embeddings |
| `user_traits_user_idx` | `user_traits` | `user_id` | normal | filter traits by user |
| `user_traits_category_idx` | `user_traits` | `category` | normal | filter traits by category |
| `user_traits_suppressed_idx` | `user_traits` | `suppressed_at` | normal | exclude soft-deleted traits |

> Note: `skills`, `skill_candidates`, `skill_usage_events`, `mcp_servers`, `connections`, `global_instructions`, `folders`, `threads`, and `verification_tokens` have **no secondary indexes** beyond their primary key. All queries against these tables filter by `user_id` / `id` / indexed columns on joined tables.

## Migrations

UmansChat uses **[drizzle-kit](https://orm.drizzle.team/docs/migrations)** for schema migrations. The workflow is:

1. Edit `src/db/schema.ts`.
2. Generate a new migration: `bunx drizzle-kit generate` (creates `drizzle/NNNN_<name>.sql`).
3. Apply migrations: `bunx drizzle-kit migrate` (reads `drizzle.config.ts`, applies pending `.sql` files in order, tracks applied state in the `__drizzle_migrations` table).

`drizzle.config.ts` points at `./src/db/schema.ts` for the schema source and `./drizzle` for the migration output folder. The DB URL resolves from `DATABASE_URL` (defaulting to `data/umanschat.db`).

### Migration runner per environment

Migrations run **before the server starts** in every deployment mode:

| Environment | How migrations run | File |
|-------------|--------------------|------|
| **Docker** | `npx drizzle-kit migrate` in the container entrypoint | `docker-entrypoint.sh` |
| **Standalone exe** | `drizzle-orm/better-sqlite3/migrator`'s `migrate()` programmatically in the launcher | `launcher/umanschat-launcher.cjs` (`runMigrations`) |
| **Local dev** | `bunx drizzle-kit migrate` in the `predev` npm hook | `package.json` (`scripts.predev`) |
| **Tests** | `drizzle-orm/better-sqlite3/migrator`'s `migrate()` programmatically in setup | `vitest.setup.ts` |

> The Docker entrypoint deliberately **does not fail** if migrations error — it logs a warning and starts the app anyway, so a migration hiccup doesn't prevent startup. The exe launcher similarly catches migration errors and continues.

### Migration files

All migration files live in the `drizzle/` folder. They are applied in numeric order (tracked by drizzle-kit in the `__drizzle_migrations` table).

| File | Description |
|------|-------------|
| `0000_dusty_invaders.sql` | **Initial schema.** Creates all base tables: `accounts`, `attachments`, `connections`, `folders`, `global_instructions`, `mcp_servers`, `memories`, `messages`, `page_embeddings`, `pages`, `sessions`, `skills`, `threads`, `users`, `verification_tokens`. Creates the initial set of indexes (see [Indexes reference](#indexes-reference)) and the `accounts_provider_unique` index. |
| `0001_many_goblin_queen.sql` | Adds skill-categorization columns to `skills`: `kind` (default `workflow`), `trigger`, `tags` (default `[]`), `scope` (default `global`), `status` (default `active`), `version` (default 1), `source_thread_id` (FK → `threads.id`), `source_message_ids`, `last_used_at`, `success_count` (default 0), `failure_count` (default 0). |
| `0002_spicy_terror.sql` | Adds per-thread generation parameters to `threads`: `temperature`, `max_tokens`, `context_length`, `auto_compact`. (These columns are defined in `schema.ts` for consistency but are not currently referenced by code.) |
| `0003` | (No file present — gap in the sequence, likely an aborted or squashed migration. No schema change required.) |
| `0004_huge_tag.sql` | Creates the `skill_candidates` table for auto-extracted skill proposals. |
| `0004_abandoned_umar.sql` | Creates the `skill_usage_events` table for skill activation logging. (Shares the `0004` prefix; order between the two `0004` files is arbitrary as they are independent table creations.) |
| `0005_strong_zaran.sql` | Adds personalization columns to `users`: `personal_style`, `personal_warmth` (default 1), `personal_energy` (default 1), `personal_structure` (default 1), `personal_emoji` (default 1). |
| `0006_puzzling_bullseye.sql` | Creates the `accounts_provider_unique` unique index on `accounts(provider, provider_account_id)` — extracted as an explicit migration for databases created before the index existed in the schema. |
| `0007_wise_abomination.sql` | Creates the `memory_injections` junction table for the memory feedback loop. Adds `valid_from`, `valid_until`, `expires_at`, `injection_count`, `last_injected_at`, `last_referenced_at` columns to `memories`, plus the `memories_expires_idx` index. |
| `0009_user_traits.sql` | Adds `translate_primary_lang` column to `users`. Creates the `user_traits` table for persistent user profile traits (always injected, not similarity-searched). Adds indexes on `user_id`, `category`, and `suppressed_at`. |

### Adding a new migration

```sh
# 1. Edit src/db/schema.ts (add/modify a table)
# 2. Generate the migration SQL
bunx drizzle-kit generate
# 3. Apply it to your local dev DB (also runs automatically via `bun run dev` predev hook)
bunx drizzle-kit migrate
```

Commit the new `drizzle/NNNN_*.sql` file. Docker, the exe launcher, and tests will apply it automatically on their next start.

## How the DB file is created on first launch

The SQLite file is **not** shipped with the app — it is created on first launch.

### Local dev

```sh
bunx drizzle-kit migrate   # creates data/umanschat.db + tables (also runs via `bun run dev` predev hook)
bun run dev                 # starts Next.js, opens the DB singleton
```

`src/db/index.ts` calls `mkdirSync(dirname(dbPath), { recursive: true })` so the `data/` directory is created automatically. When `better-sqlite3` opens a path that does not exist (and the integrity-check probe is skipped because `fileMustExist` only applies to the probe), it creates a fresh empty database file; the subsequent `drizzle-kit migrate` then builds the schema.

### Docker

1. The entrypoint resolves `DATABASE_URL` to an absolute path under `/app` (default `/app/data/umanschat.db`) so the standalone server and the migration command share the same file regardless of CWD.
2. It creates the data directory with `mkdir -p`.
3. It removes stale `*.db-wal` / `*.db-shm` sidecars.
4. It runs `npx drizzle-kit migrate`, which creates the file if missing and applies all migrations.

The `data/` directory is volume-mounted so the database persists across container restarts.

### Standalone exe

`launcher/umanschat-launcher.cjs`:

1. Resolves the app root and the `.env` file.
2. `resolveDbPath()` reads `DATABASE_URL` from `.env` (defaulting to `data/umanschat.db`) and makes it absolute relative to the app root.
3. `runMigrations()` creates the data directory, opens a temporary `better-sqlite3` connection, and calls `drizzle-orm`'s `migrate()` programmatically with `migrationsFolder = <appRoot>/drizzle`.
4. Closes the temporary connection; the main server process then opens the singleton and serves.

## Embedding storage

UmansChat stores embedding vectors as **JSON text arrays**, not as native vector columns:

```ts
// src/db/schema.ts
embedding: text("embedding", { mode: "json" }).$type<number[]>().notNull(),
```

SQLite has no native vector type, and UmansChat deliberately avoids extensions like `sqlite-vec` or `pgvector`. Instead:

- The column type is `text`, stored as a JSON-serialized array of numbers (e.g. `[0.0123, -0.0456, …]`).
- The **dimensionality is not enforced at the column level** — any-length array is accepted by SQLite.
- The expected dimension comes from the `EMBED_DIM` environment variable (default `1024`, matching `LFM2.5-Embedding-350M`). It is used by the **client-side cosine similarity function** in `src/lib/vectorSearch.ts` for validation, not by the database.
- Cosine similarity is computed in application code by loading candidate vectors and comparing in JS. There is no vector index; candidate sets are pre-filtered by `user_id` / `folder_id` / `kind` via standard SQL indexes before the in-memory comparison.

This design means:

- **No DDL is needed when changing `EMBED_DIM`.** Switching embedding models only requires clearing the now-incompatible vector data. The Settings GUI's embedding-model migration (`applyMigration`) deletes all rows from `memories` and `page_embeddings` and re-embeds `skills` (user-created, persistent). See [Memory System](./memory.md) and [Skills System](./skills.md).
- **No vector extension dependency.** No `pgvector`, no `sqlite-vec`, no HNSW index to maintain or rebuild.
- **Column type is dimension-agnostic.** The same `embedding` column stores 384-, 768-, or 1024-dimensional vectors without a schema change.

## See also

- [Architecture](./architecture.md) — overall system architecture and how the database fits in
- [Authentication & User Isolation](./authentication.md) — Auth.js integration and the `users`/`accounts`/`sessions`/`verification_tokens` tables in context
- [Memory System](./memory.md) — how `memories` power RAG and memory injection
- [Skills System](./skills.md) — how `skills`, `skill_candidates`, and `skill_usage_events` power skill injection
