# SSE URL Remote MCP Connector — Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]` / `- [x]`) syntax for tracking.  
> **Status:** **Not started** (plan only; implementation deferred to a separate session/model).  
> **Created:** 2026-07-17  
> **Last progress update:** 2026-07-17

**Goal:** Make remote MCP over URL a production-quality “connector”: Streamable HTTP + explicit legacy SSE, optional request headers (Bearer / API key), connection test, SSRF guard, and UI that can register `https://…/mcp` or `https://…/sse` servers. Do **not** implement first-party OAuth Connection providers (Google Drive, etc.) in this plan — those stay on remote/stdio MCP.

### Implementation status (summary)

| Area | Status | Notes |
|------|--------|--------|
| Phase 0 — SDK / docs discovery | **Not started** | |
| Phase 1 — Schema + URL guard + connect core | **Not started** | |
| Phase 2 — API (CRUD + test) | **Not started** | |
| Phase 3 — UI + i18n | **Not started** | |
| Phase 4 — Docs + README | **Not started** | |
| Phase 5 — Verification | **Not started** | |
| OAuth Connection providers (Drive, etc.) | **Out of scope** | Use remote MCP instead |
| MCP OAuth 2.1 / Dynamic Client Registration | **Out of scope (v2)** | |

---

## Product decision (locked)

| Decision | Choice |
|----------|--------|
| Primary vehicle | **MCP** (`mcp_servers` + `mcpClient.ts`), not `connections` |
| SSE URL connector | First-class remote MCP: URL + optional headers + transport mode |
| Google Drive / Slack / GitHub, etc. | Connect via **remote or stdio MCP** owned outside UmansChat |
| Notion-style OAuth Connection | Keep as-is for Notion only; do **not** mass-produce providers here |
| Connection lifecycle | Stay **request-scoped** (open at chat start, close in `finally`) |

### Why not OAuth Connection for every SaaS

| | Remote MCP (this plan) | OAuth Connection (Notion pattern) |
|--|------------------------|-----------------------------------|
| OAuth / tokens | MCP server owns them | UmansChat owns them |
| Tools | Dynamic from MCP `listTools` | Hardcoded in `connections/index.ts` |
| Cost per provider | Near zero in UmansChat | authorize + callback + refresh + tools + tests |
| When to use | Default for Drive, GitHub, custom APIs | Only when in-app one-click OAuth is a product requirement |

---

## Current state (baseline)

### Already works

- DB: `mcp_servers` with `transport` `http` \| `stdio`, optional `url` / `command` / `args` / `env`
- Client: `src/lib/mcpClient.ts`
  - `http` → try `StreamableHTTPClientTransport`, fall back to `SSEClientTransport`
  - `stdio` → `StdioClientTransport` with binary allowlist
- API: `GET/POST /api/mcp-servers`, `PATCH/DELETE /api/mcp-servers/[id]`
- UI: `McpPanel` (name, transport http/stdio, url or command+args)
- Chat: `thread.mcpServerIds` → connect → `listMcpTools` → `serverName__toolName` dispatch → close in `finally`
- Docs: `docs/tool-calling.md` (HTTP / SSE fallback)

### Gaps this plan closes

| # | Gap | Impact |
|---|-----|--------|
| 1 | No `headers` on remote MCP | Cannot auth to Bearer/API-key remote servers |
| 2 | No explicit `sse` transport | `/sse`-only servers always pay failed Streamable attempt |
| 3 | Same `Client` reused after Streamable failure | Unstable SSE fallback |
| 4 | No connection test endpoint | Users cannot verify before chat |
| 5 | Weak SSRF posture | Server-side fetch of arbitrary URLs |
| 6 | Thin UI | No headers, no SSE option, no test feedback |
| 7 | Secrets in GET list | Risk of leaking headers in list responses |

### Known SDK options (verify in Phase 0)

From `@modelcontextprotocol/sdk` (installed types):

- `SSEClientTransport(url, { requestInit?, eventSourceInit?, authProvider?, fetch? })` — **deprecated** but still needed for legacy servers
- `StreamableHTTPClientTransport(url, { requestInit?, authProvider?, fetch? })`
- Prefer `requestInit.headers` for Authorization; confirm EventSource path also receives headers (custom `fetch` if not)

---

## Architecture (target)

```
User registers remote MCP (name, transport=http|sse, url, headers?)
  → POST /api/mcp-servers  (SSRF guard + validation)
  → optional POST /api/mcp-servers/test  (connect + listTools)

Chat turn (thread.mcpServerIds)
  → load mcp_servers rows (incl. headers)
  → connectMcpServer(config)
       sse  → new Client + SSEClientTransport(url, { requestInit: { headers } })
       http → try StreamableHTTP (new Client + headers)
              on failure → NEW Client + SSEClientTransport (never reuse failed Client)
       stdio → unchanged
  → listTools → OpenAI tools as {serverName}__{toolName}
  → streamCompletion dispatch callMcpTool
  → finally client.close()
```

**Non-goals for chat path:** connection pooling, long-lived SSE across requests, changing tool name separator.

---

## Global constraints

| Constraint | Source |
|------------|--------|
| Prefer extending MCP over new systems | Product decision |
| No new OAuth Connection providers in this plan | Product decision |
| Never edit existing Drizzle migration files | `docs/patterns/db-migration.md` |
| Co-locate tests `*.test.ts` / `*.test.tsx` | AGENTS.md |
| `// @vitest-environment node` for `src/lib/*` and API routes | AGENTS.md |
| Do not log header values or tokens | Security |
| SSE remains available but labeled legacy | MCP spec deprecation |
| `bun run test` green before claiming done | AGENTS.md |
| README EN + JA stay in sync if user-facing | `skill://readme-update-guide` |

### Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `MCP_ALLOW_PRIVATE_URLS` | unset / `false` | When `true`, allow private/loopback URLs for remote MCP (self-host / dev). Default reject. |

No new secrets env vars required for generic remote MCP (tokens live in per-user `headers` JSON).

---

## Schema changes

### `mcp_servers` (extend)

| Column | Type | Notes |
|--------|------|-------|
| `headers` | `text` JSON `Record<string, string> \| null` | Optional HTTP headers for remote transports only |
| `transport` enum | `"http" \| "sse" \| "stdio"` | Add `sse` (was `http` \| `stdio` only) |

**Semantics:**

| `transport` | Behavior |
|-------------|----------|
| `http` | Prefer Streamable HTTP; on failure use **fresh** Client + SSE |
| `sse` | SSE only (`SSEClientTransport`); do not try Streamable first |
| `stdio` | Unchanged; `headers` ignored / must be null |

**Migration:** edit `src/db/schema.ts` → `bunx drizzle-kit generate` → apply via existing migrate path. Never edit old SQL files.

---

## Module layout (target)

```
src/lib/
  mcpClient.ts          # connect modes + headers; fix Client reuse
  mcpClient.test.ts     # expand beyond validateMcpStdioCommand
  mcpUrlGuard.ts        # NEW — URL / SSRF checks
  mcpUrlGuard.test.ts   # NEW

src/app/api/mcp-servers/
  route.ts              # POST accepts headers + transport sse
  [id]/route.ts         # PATCH same
  test/route.ts         # NEW — connection probe

src/components/
  McpPanel.tsx          # SSE option, headers UI, Test button
  McpPanel.test.tsx     # NEW or extend if present

src/lib/i18n/dictionaries.ts
docs/tool-calling.md, database.md, api-routes.md, glossary.md
README.md, README.ja.md
```

**Do not touch unless necessary:** `src/app/api/chat/route.ts` beyond passing `headers` / new transport through existing MCP load path; `src/lib/connections/**` (OAuth providers out of scope).

---

## Phase 0 — Documentation / SDK discovery

**What:** Confirm real SDK APIs before coding. Do not invent option names.

- [ ] Read `node_modules/@modelcontextprotocol/sdk/dist/esm/client/sse.d.ts` and `streamableHttp.d.ts`
- [ ] Confirm how to attach `Authorization` to SSE (EventSource) **and** POST message path
- [ ] Note if `authProvider` is required for any common remote servers (v1 still uses static headers only)
- [ ] Re-read `docs/tool-calling.md` MCP section and `src/lib/mcpClient.ts` connect path
- [ ] Write a short “Allowed APIs” note in the PR/commit body (which options carry headers)

**Verification:**

- [ ] Headers path documented for both Streamable and SSE
- [ ] Anti-pattern list: no query-string tokens, no reusing one Client after failed connect

**Anti-patterns:**

- Assuming `headers` constructor arg exists (it does not — use `requestInit` / custom `fetch`)
- Skipping EventSource auth check

---

## Phase 1 — Schema + URL guard + connect core

### Task 1.1 — Schema + migration

- [ ] Add `headers` JSON column to `mcpServers` in `src/db/schema.ts`
- [ ] Extend `transport` enum to include `"sse"`
- [ ] Generate migration with `bunx drizzle-kit generate` (do not hand-edit old migrations)
- [ ] Apply migration in dev (`bunx drizzle-kit migrate` or `predev` path)

**Copy patterns from:** `docs/patterns/db-migration.md`, existing `mcpServers` block in `src/db/schema.ts` (~lines 209–226)

### Task 1.2 — `mcpUrlGuard.ts`

- [ ] Export e.g. `assertMcpRemoteUrl(url: string): { ok: true; url: URL } | { ok: false; reason: string }`
- [ ] Allow `https:` always for remote
- [ ] Allow `http:` only for loopback when private URLs allowed, or document strict https-only + env override
- [ ] Reject private IPv4/IPv6, link-local, metadata IP `169.254.169.254` by default
- [ ] Honor `MCP_ALLOW_PRIVATE_URLS=true` to relax for self-host
- [ ] Tests: happy https, reject private, reject weird schemes, env override

**File:** `src/lib/mcpUrlGuard.ts`, `src/lib/mcpUrlGuard.test.ts`  
**Env for tests:** `// @vitest-environment node`

### Task 1.3 — `connectMcpServer` upgrade

- [ ] Extend `McpServerConfig` with `headers: Record<string, string> | null` and `transport: "http" | "sse" | "stdio"`
- [ ] `transport === "sse"`: single path using `SSEClientTransport` + headers; no Streamable attempt
- [ ] `transport === "http"`: Streamable with headers on **new** Client; on failure log warn, **new** Client + SSE + headers
- [ ] Pass headers via SDK `requestInit` (and EventSource custom fetch if Phase 0 requires it)
- [ ] Never log header values (log only `hasHeaders: boolean` / server name)
- [ ] stdio path unchanged; ignore headers
- [ ] Unit tests with mocked transports or injectable connect hooks if pure unit is hard — at minimum test pure helpers (name parse already exists; add tests for config validation / header stripping of empty keys)

**File:** `src/lib/mcpClient.ts`, expand `src/lib/mcpClient.test.ts`

**Verification:**

- [ ] `sse` never constructs `StreamableHTTPClientTransport`
- [ ] `http` fallback constructs two separate Client lifecycles
- [ ] Guard rejects bad URLs before network

**Anti-patterns:**

- Reusing Client after failed `connect`
- Putting tokens in URL query
- Weakening stdio allowlist

---

## Phase 2 — API

### Task 2.1 — Create / update validation

- [ ] `POST /api/mcp-servers`: accept `transport: "sse"`, `headers?: Record<string, string>`
- [ ] `sse` and `http` require non-empty `url`; run `assertMcpRemoteUrl`
- [ ] Normalize headers: trim keys/values; drop empty; optional max entry count (e.g. 20)
- [ ] `stdio` must not persist headers (force null)
- [ ] `PATCH /api/mcp-servers/[id]`: same rules
- [ ] GET list: **do not return raw header values** — return `hasHeaders: boolean` (and omit `headers` or always null in JSON). Document that edit flows re-submit full headers if changing auth.

**Patterns:** `docs/patterns/api-route.md`, existing `src/app/api/mcp-servers/route.ts`

### Task 2.2 — Connection test route

- [ ] Add `POST /api/mcp-servers/test`
- [ ] Body: `{ name?, transport, url?, command?, args?, env?, headers? }` (same shape as create; id optional if testing saved server later)
- [ ] Auth: `getSessionUser()` required
- [ ] For remote: guard URL → `connectMcpServer` → `listMcpTools` → close client
- [ ] Response 200: `{ ok: true, transportUsed: "http" | "sse" | "stdio", tools: [{ name, description }] }`
- [ ] Soft failure 200 or 400: `{ ok: false, error: string }` — no stack traces to client
- [ ] Timeout: reasonable upper bound (e.g. 15s) so hung SSE does not pin the request forever
- [ ] Tests: 401 unauthenticated, 400 missing url, mock connect success/failure

**File:** `src/app/api/mcp-servers/test/route.ts`, `test/route.test.ts`

**Verification:**

- [ ] Route tests green under node env
- [ ] Existing http/stdio create still works

**Anti-patterns:**

- Returning secrets in GET or test response
- Calling test without auth

---

## Phase 3 — UI + i18n

### Task 3.1 — `McpPanel`

- [ ] Transport select: HTTP (Streamable / auto SSE), SSE (legacy URL), stdio
- [ ] When http/sse: URL field placeholders `https://example.com/mcp` and `https://example.com/sse`
- [ ] Headers UI (minimal viable): one textarea `Header-Name: value` per line, or key/value rows — parse client-side into object
- [ ] “Test connection” button → `POST /api/mcp-servers/test` → show tool count or error inline
- [ ] On successful add, clear sensitive fields from form state
- [ ] List row: show transport badge; show lock/icon if `hasHeaders` without printing secrets
- [ ] Delete / per-thread checkbox behavior unchanged

**File:** `src/components/McpPanel.tsx`  
**Pattern:** existing panel structure; `docs/patterns/component.md` if needed

### Task 3.2 — i18n

- [ ] Add keys to Japanese first, then English mirror in `src/lib/i18n/dictionaries.ts`
- [ ] Suggested keys: transport SSE label, headers label, headers placeholder, test button, test success/fail, hasHeaders indicator

### Task 3.3 — Component tests

- [ ] Submit body includes `transport: "sse"` and parsed `headers` when filled
- [ ] Test button calls `/api/mcp-servers/test`

**Verification:**

- [ ] Manual smoke: register SSE URL → Test → enable on thread → tool call in chat (if a test MCP is available)
- [ ] Component tests pass

**Anti-patterns:**

- Logging headers to console
- Storing headers in `localStorage`

---

## Phase 4 — Documentation + README

- [ ] `docs/tool-calling.md` — document `sse` transport, headers, test API, Client-per-attempt fallback, request-scoped lifecycle
- [ ] `docs/database.md` — `headers` column + transport enum
- [ ] `docs/api-routes.md` — POST body fields, GET `hasHeaders`, `POST .../test`
- [ ] `docs/glossary.md` — short “Remote MCP / SSE URL connector” under Tools & Integrations; clarify vs OAuth Connection
- [ ] `docs/settings-env.md` — `MCP_ALLOW_PRIVATE_URLS` if documented env is the project norm
- [ ] `README.md` + `README.ja.md` — how to add a remote MCP URL connector; note Drive/etc. via MCP not built-in OAuth; dual-file parity per `skill://readme-update-guide`

**Verification:**

- [ ] EN/JA README say the same things
- [ ] No claim that Google Drive is a first-party Connection

---

## Phase 5 — Verification (mandatory before done)

```bash
bun run test
# typecheck if package.json provides it
```

Checklist:

- [ ] stdio MCP still connects and dispatches
- [ ] Streamable HTTP URL works with `transport=http`
- [ ] Legacy SSE URL works with `transport=sse`
- [ ] Headers applied (mock server asserting Authorization, or integration against a known remote)
- [ ] Private IP URLs rejected unless `MCP_ALLOW_PRIVATE_URLS=true`
- [ ] GET list does not leak header values
- [ ] Chat tool loop still uses `name__tool` and closes clients in `finally`
- [ ] `git status --short` clean; commit message in English; push `develop` per AGENTS.md
- [ ] No secrets committed

---

## Milestones (cost-aware)

| Milestone | Phases | Outcome |
|-----------|--------|---------|
| **M1** | 0–2 | Headless: API + core can connect SSE/HTTP with headers and test |
| **M2** | 3 | Users can configure from UI |
| **M3** | 4–5 | Docs + release-ready verification |

Implementers may ship M1 first if another model/session continues UI later.

---

## Out of scope / v2 backlog

| Item | Notes |
|------|-------|
| Google Drive / GitHub / Slack OAuth Connection providers | Use remote or stdio MCP servers instead |
| MCP OAuth 2.1 + `authProvider` browser flow | SDK supports it; large UX surface |
| Connection pooling / cross-request SSE keep-alive | Latency optimization only |
| Unified “Connectors” UI merging Connections + MCP | Display-only merge later; keep storage separate |
| WebSocket MCP transport | Not required for URL SSE/HTTP goal |
| Catalog of preset remote MCP URLs | Nice-to-have |

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| SSE deprecated in MCP spec | Default `http` (Streamable); keep `sse` explicit and labeled legacy |
| Header leakage | Mask on GET; never log values; local SQLite still treat as secret |
| SSRF | `mcpUrlGuard` + default private deny + env escape hatch |
| Unstable Streamable→SSE fallback | New Client per attempt; prefer explicit `sse` when URL is `/sse` |
| Hung connect on test/chat | Timeouts on test route; chat already non-blocking skip on connect null |
| Per-request reconnect latency | Accept in v1; document; pool only in v2 if measured pain |

---

## Reference map for implementers

| Concern | Source |
|---------|--------|
| Connect / list / call / name parse | `src/lib/mcpClient.ts` |
| MCP in chat | `docs/tool-calling.md`, `src/app/api/chat/route.ts` (MCP block) |
| CRUD API | `src/app/api/mcp-servers/route.ts`, `[id]/route.ts` |
| UI | `src/components/McpPanel.tsx` |
| Schema | `src/db/schema.ts` `mcpServers` |
| Migration workflow | `docs/patterns/db-migration.md` |
| API route pattern | `docs/patterns/api-route.md` |
| Tests | `docs/patterns/test.md`, `src/lib/mcpClient.test.ts` |
| Work completion | `skill://work-completion-checklist` |
| README dual update | `skill://readme-update-guide` |

---

## Suggested commit sequence (when implementing)

1. `feat(mcp): add sse transport, headers column, and url guard`
2. `feat(mcp): connection test API and secret-safe list responses`
3. `feat(mcp): McpPanel SSE/headers/test UI + i18n`
4. `docs(mcp): remote SSE URL connector usage and env`

Or one commit if the implementing session is small — still run full Phase 5 checks.

---

## Open questions (non-blocking defaults)

| Question | Default for implementer |
|----------|-------------------------|
| GET: completely omit headers vs empty object? | Prefer `hasHeaders` only; omit `headers` key |
| http:// allowed for LAN without env? | No — require `MCP_ALLOW_PRIVATE_URLS` |
| Max header value length? | e.g. 4 KiB per value, 20 headers |
| Test route timeout? | 15s |

If product later wants first-party Google Drive OAuth, open a **separate** plan under Connections — do not overload this MCP connector plan.
