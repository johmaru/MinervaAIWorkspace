# OAuth Connectors — Implementation Plan (Handoff)

> **Handoff plan:** This document was written for a **different model / session** to implement.  
> Do **not** assume any prior chat context. Everything needed is in this file + the cited repo paths.  
> **Planner role:** planning only. **Implementer role:** you (the agent executing this plan).  
> **Status:** **Not started.** Check off `- [ ]` → `- [x]` as you go. Update the status table.  
> **Created:** 2026-07-17  

---

## 0. How to use this plan (implementer)

### 0.1 Execution rules

1. Work **one phase at a time**. Prefer: finish Phase N verification before starting Phase N+1.
2. **Copy** from cited files; do not invent OAuth URLs, env names, or tool shapes that contradict this plan.
3. **Phase 0 is mandatory** for each platform family before writing live API calls (Google / GitHub / Microsoft). Record verified endpoints in a short “Allowed APIs (verified)” subsection at the bottom of this file or in a comment block in the provider module.
4. After every phase: run `bun run test` and `bun run typecheck`. Fix failures before continuing.
5. Follow project rules in `AGENTS.md` (tests co-located, no `__tests__/`, migration never rewrite, dual README when user-facing).
6. When done with a logical chunk, **commit** with a clear message (user may want push separately — ask before `git push` unless user said to push).
7. Do **not** implement remote-MCP substitutes for these six connectors. This plan is first-party OAuth Connections only.
8. Do **not** change Auth.js login Google OAuth behavior (`GOOGLE_CLIENT_ID` / login flow).

### 0.2 Recommended session split (for a new chat each time)

| Session | Scope | Must leave green |
|---------|--------|------------------|
| A | Phase 0 (docs notes) + Phase 1 (platform) | tests + typecheck |
| B | Phase 2 GitHub end-to-end (routes + tools + settings + tests) | tests + typecheck |
| C | Phase 3 Google family | tests + typecheck |
| D | Phase 4 Microsoft family | tests + typecheck |
| E | Phase 5 UI polish + Phase 6 docs + Phase 7 verify | tests + typecheck + README EN/JA |

Start each new session by reading **this file only**, then the “Canonical copy sources” section files.

### 0.3 Definition of Done (whole feature)

- [ ] All 6 providers can OAuth-connect when env credentials are set
- [ ] Tools dispatch correctly with **multiple** connections enabled on one thread
- [ ] Token refresh persists (access-only updates allowed; refresh optional)
- [ ] Notion still works
- [ ] Login Google still works
- [ ] Secrets never returned by GET settings/list connections
- [ ] Tests + typecheck green
- [ ] Docs + README EN/JA + `.env.example` updated
- [ ] Glossary no longer says “do not build first-party OAuth for Drive/GitHub”

---

## 1. Goal

Ship **first-party OAuth Connection providers** (same pattern as Notion) for:

| UI label | `provider` (DB) | Tool name prefix | Shared OAuth client env |
|----------|-----------------|------------------|-------------------------|
| Gmail | `gmail` | `gmail_` | `GOOGLE_CONNECTIONS_CLIENT_ID` / `GOOGLE_CONNECTIONS_CLIENT_SECRET` |
| Google Drive | `google_drive` | `gdrive_` | same Google env |
| Google Calendar | `google_calendar` | `gcal_` | same Google env |
| GitHub | `github` | `github_` | `GITHUB_CONNECTIONS_CLIENT_ID` / `GITHUB_CONNECTIONS_CLIENT_SECRET` |
| Outlook (Mail) | `outlook` | `outlook_` | `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT_ID` |
| Outlook Calendar | `outlook_calendar` | `outcal_` | same Microsoft env |

**Behavior (same as Notion):**

1. User saves client credentials in Settings → Connections.
2. User clicks Connect → `GET /api/connections/{provider}/authorize` → provider consent.
3. Callback stores tokens in `connections` table.
4. User enables connection IDs on a thread (`thread.connectionIds`).
5. Chat loads tools from `getConnectionTools` and dispatches via `dispatchConnectionTool`.
6. On 401, refresh token and persist new tokens.

---

## 2. Product decisions (LOCKED — do not re-open)

| # | Decision | Value |
|---|----------|--------|
| D1 | Integration type | OAuth **Connection** (`connections` table), **not** MCP |
| D2 | Granularity | **One DB row per product** (6 providers + existing `notion`) |
| D3 | Google credentials | **Separate** from login: `GOOGLE_CONNECTIONS_*` ≠ `GOOGLE_CLIENT_*` |
| D4 | Tool MVP | Read-heavy; calendar **create event** allowed; **no** mail send / bulk delete in v1 |
| D5 | CSRF state | `state = userId` (copy Notion) |
| D6 | Redirect origin | `resolvePublicOrigin(req.headers, getConfiguredAuthUrl())` (copy Notion) |
| D7 | Token storage | Plaintext columns like Notion (no encryption in v1) |
| D8 | Multi-provider dispatch | **Prefix → provider → find row**; never `connectionRows[0]` |
| D9 | Persist refresh | Persist when `newAccessToken` present; `newRefreshToken` optional |
| D10 | Routes | **Explicit** per-provider authorize/callback folders (copy Notion), not dynamic `[provider]` in v1 |
| D11 | Prior doc conflict | Glossary / SSE plan said “use MCP not OAuth” — **this plan overrides** for these 6 only |

### Non-goals (do not implement)

- MCP OAuth 2.1 / DCR
- Encrypt tokens at rest
- `gmail_send`, bulk Drive upload, GitHub PR write tools
- Reusing Auth.js `accounts` tokens for API calls
- Auto-enable all connections on every thread
- New npm dependencies unless strictly necessary (prefer `fetch`)

---

## 3. Canonical copy sources (read these first)

| What | Path | Why |
|------|------|-----|
| Schema `connections` | `src/db/schema.ts` (~L235–255) | Enum currently `["notion"]` only |
| List/delete API | `src/app/api/connections/route.ts` | Never return tokens |
| Authorize | `src/app/api/connections/notion/authorize/route.ts` | Full template for new providers |
| Callback | `src/app/api/connections/notion/callback/route.ts` | Full template |
| OAuth + API client | `src/lib/connections/notion.ts` | exchange / refresh / callApi + 401 retry |
| Tools registry | `src/lib/connections/index.ts` | `getConnectionTools` / `dispatchConnectionTool` |
| Chat load tools | `src/app/api/chat/route.ts` (~L277–289 area: `loadConnections`) | How tools attach |
| Chat dispatch **BUG for multi** | `src/app/api/chat/route.ts` (~L2147–2173) | `startsWith("notion_")` + `connectionRows[0]` — **must fix in Phase 1** |
| Settings GET/PATCH env | `src/app/api/settings/route.ts` | Notion env mask pattern (`hasNotionClientSecret`) |
| Settings UI | `src/components/SettingsModal.tsx` Connections tab (~L1221–1293) | Notion-only UI to extend |
| Thread picker UI | `src/components/ChatWindow.tsx` (~L42–80, ~L355–399) | Lists connections; shows `workspaceName` |
| Success query strip | `src/components/ChatWindow.tsx` (~L116) | `connection_success` |
| Help | `src/components/HelpModal.tsx` | Notion-only topic today |
| i18n | `src/lib/i18n/dictionaries.ts` | JA then EN |
| Extensibility docs | `docs/tool-calling.md` § Connections + Extensibility | Official steps |
| API route pattern | `docs/patterns/api-route.md` | Auth + user scope |
| Migration pattern | `docs/patterns/db-migration.md` | `bunx drizzle-kit generate` |
| Test pattern | `docs/patterns/test.md` | co-locate; node env first line |
| Origin helper | `src/lib/request-origin.ts` | dual host |
| Env example | `.env.example` | document new vars |

### Commands (implementer)

```bash
bunx drizzle-kit generate    # after schema edit
bunx drizzle-kit migrate     # or rely on predev
bun run test
bun run typecheck
```

---

## 4. Architecture (target)

```
Settings save env → Connect {provider}
  GET /api/connections/{provider}/authorize
    origin = resolvePublicOrigin(...)
    redirect_uri = {origin}/api/connections/{provider}/callback
    state = user.id
    scope = PRODUCT_SCOPES[provider]
  → provider consent
  GET .../callback?code&state
    state === user.id
    exchange code → tokens
    INSERT connections { provider, accessToken, refreshToken?, scopes?, expiresAt?, metadata }
    redirect /?connection_success={provider}

Chat (thread.connectionIds)
  loadConnections(userId, ids)
  tools = flatMap(getConnectionTools)
  on tool call name:
    provider = resolveProviderFromToolName(name)  // gmail_search → gmail
    conn = rows.find(r => r.provider === provider)
    dispatchConnectionTool(conn, name, args)
    if newAccessToken → UPDATE connections
```

### Target files to create/modify

```
CREATE:
  src/lib/connections/types.ts
  src/lib/connections/provider-map.ts
  src/lib/connections/google-oauth.ts
  src/lib/connections/microsoft-oauth.ts
  src/lib/connections/github.ts
  src/lib/connections/gmail.ts
  src/lib/connections/google-drive.ts
  src/lib/connections/google-calendar.ts
  src/lib/connections/outlook.ts
  src/lib/connections/outlook-calendar.ts
  src/lib/connections/*.test.ts  (co-located)
  src/app/api/connections/github/authorize/route.ts
  src/app/api/connections/github/callback/route.ts
  src/app/api/connections/gmail/authorize/route.ts
  src/app/api/connections/gmail/callback/route.ts
  src/app/api/connections/google_drive/authorize/route.ts
  src/app/api/connections/google_drive/callback/route.ts
  src/app/api/connections/google_calendar/authorize/route.ts
  src/app/api/connections/google_calendar/callback/route.ts
  src/app/api/connections/outlook/authorize/route.ts
  src/app/api/connections/outlook/callback/route.ts
  src/app/api/connections/outlook_calendar/authorize/route.ts
  src/app/api/connections/outlook_calendar/callback/route.ts
  drizzle/00xx_*.sql  (generated only)

MODIFY:
  src/db/schema.ts
  src/lib/connections/index.ts
  src/app/api/chat/route.ts          # multi-provider dispatch + token persist
  src/app/api/settings/route.ts      # new env keys + masking
  src/app/api/settings/route.test.ts
  src/components/SettingsModal.tsx
  src/components/SettingsModal.test.tsx
  src/components/ChatWindow.tsx      # provider labels in picker if needed
  src/components/HelpModal.tsx       # optional help topics
  src/lib/i18n/dictionaries.ts
  .env.example
  docs/tool-calling.md
  docs/api-routes.md
  docs/authentication.md
  docs/settings-env.md               # if exists / create entries
  docs/glossary.md
  docs/database.md
  docs/frontend.md
  README.md
  README.ja.md
```

---

## 5. Schema change (exact intent)

Edit `src/db/schema.ts` `connections` table:

```ts
provider: text("provider", {
  enum: [
    "notion",
    "gmail",
    "google_drive",
    "google_calendar",
    "github",
    "outlook",
    "outlook_calendar",
  ],
}).notNull(),

// NEW:
scopes: text("scopes"), // space-separated granted scopes, nullable
expiresAt: integer("expires_at", { mode: "timestamp_ms" }), // nullable

// CHANGE:
refreshToken: text("refresh_token"), // nullable (was .notNull())
// accessToken remains NOT NULL
```

Then:

```bash
bunx drizzle-kit generate
# review SQL; do not hand-edit old migrations
bunx drizzle-kit migrate
```

If SQLite requires table rebuild for NOT NULL → NULL, accept drizzle-kit output.

**Metadata field reuse (no new columns for display):**

| Column | Meaning for new providers |
|--------|---------------------------|
| `workspaceName` | Primary display: “Gmail”, repo owner, GitHub login, mailbox name |
| `ownerEmail` | Account email when known |
| `ownerName` | Display name / login |
| `botId` | Provider user id string |
| `workspaceIcon` | Avatar URL when available |

---

## 6. Provider map (implement exactly)

File: `src/lib/connections/provider-map.ts`

```ts
export type ProviderId =
  | "notion"
  | "gmail"
  | "google_drive"
  | "google_calendar"
  | "github"
  | "outlook"
  | "outlook_calendar";

/** Longest-prefix-safe: match by startsWith in order of specificity if needed */
export const TOOL_PREFIX_BY_PROVIDER: Record<ProviderId, string> = {
  notion: "notion_",
  gmail: "gmail_",
  google_drive: "gdrive_",
  google_calendar: "gcal_",
  github: "github_",
  outlook: "outlook_",
  outlook_calendar: "outcal_",
};

export function resolveProviderFromToolName(toolName: string): ProviderId | null {
  // IMPORTANT: check longer/unique prefixes; current set has no prefix collisions.
  for (const [provider, prefix] of Object.entries(TOOL_PREFIX_BY_PROVIDER) as [ProviderId, string][]) {
    if (toolName.startsWith(prefix)) return provider;
  }
  return null;
}
```

Unit-test every prefix and a negative case (`sandbox_run` → null).

---

## 7. Chat route fix (Phase 1 — critical)

**Current (broken for multi-provider)** — `src/app/api/chat/route.ts` ~2147:

```ts
} else if (tc.name.startsWith("notion_") && connectionRows && connectionRows.length > 0) {
  const conn = connectionRows[0];
  // ...
  if (result.newAccessToken && result.newRefreshToken) { /* persist both only */ }
}
```

**Required replacement behavior:**

```ts
} else if (connectionRows && connectionRows.length > 0) {
  const provider = resolveProviderFromToolName(tc.name);
  if (!provider) {
    toolContent = `Unknown tool: ${tc.name}`;
  } else {
    const conn = connectionRows.find((c) => c.provider === provider);
    if (!conn) {
      toolContent = `No active connection for provider: ${provider}`;
    } else {
      // status event; parse args; dispatchConnectionTool
      // Persist if result.newAccessToken:
      //   accessToken always; refreshToken only if result.newRefreshToken; expiresAt if present
    }
  }
}
```

Wire this so **Notion** still works (prefix `notion_`).

Also update `dispatchConnectionTool` return type to allow optional `newRefreshToken` and optional `expiresAt`.

---

## 8. Shared OAuth helpers (after Phase 0 verify)

### 8.1 Google — `src/lib/connections/google-oauth.ts`

**Expected endpoints (verify in Phase 0; adjust if docs differ):**

| Step | Method | URL |
|------|--------|-----|
| Authorize | GET | `https://accounts.google.com/o/oauth2/v2/auth` |
| Token / refresh | POST | `https://oauth2.googleapis.com/token` (form-urlencoded) |

**Authorize query params:**

- `client_id`, `redirect_uri`, `response_type=code`, `state`
- `scope` (space-separated)
- `access_type=offline`
- `prompt=consent` (ensure refresh_token)

**Token exchange body:** `code`, `client_id`, `client_secret`, `redirect_uri`, `grant_type=authorization_code`  
**Refresh body:** `client_id`, `client_secret`, `refresh_token`, `grant_type=refresh_token`

**API bases:**

| Product | Base |
|---------|------|
| Gmail | `https://gmail.googleapis.com/gmail/v1` |
| Drive | `https://www.googleapis.com/drive/v3` |
| Calendar | `https://www.googleapis.com/calendar/v3` |

Export:

- `exchangeGoogleCode(code, redirectUri)`
- `refreshGoogleToken(refreshToken)`
- `callGoogleApi({ accessToken, refreshToken, method, url, body? })` → `{ ok, data?, error?, newAccessToken?, newRefreshToken?, expiresAt? }`

Env: `GOOGLE_CONNECTIONS_CLIENT_ID`, `GOOGLE_CONNECTIONS_CLIENT_SECRET`.

### 8.2 Microsoft — `src/lib/connections/microsoft-oauth.ts`

| Step | URL |
|------|-----|
| Authorize | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` |
| Token | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` |
| Graph | `https://graph.microsoft.com/v1.0` |

`tenant` = `process.env.MICROSOFT_TENANT_ID || "common"`.

Always request `offline_access` for refresh.

### 8.3 GitHub — inside `github.ts`

| Step | URL |
|------|-----|
| Authorize | `https://github.com/login/oauth/authorize` |
| Token | `https://github.com/login/oauth/access_token` (`Accept: application/json`) |
| API | `https://api.github.com` |

Headers for API: `Authorization: Bearer …`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` (verify current recommended version in Phase 0), `User-Agent: UmansChat`.

---

## 9. Scopes (v1 defaults — re-verify Phase 0)

| Provider | Scopes string |
|----------|----------------|
| `gmail` | `https://www.googleapis.com/auth/gmail.readonly` |
| `google_drive` | `https://www.googleapis.com/auth/drive.readonly` |
| `google_calendar` | `https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events` |
| `github` | `read:user repo` |
| `outlook` | `offline_access User.Read Mail.Read` |
| `outlook_calendar` | `offline_access User.Read Calendars.Read Calendars.ReadWrite` |

---

## 10. v1 tools (implement only these)

**Truncation:** cap tool result text ~8–12KB; prefer lists of ids + short previews.

### GitHub (`github_`)

| Tool | Args | Behavior |
|------|------|----------|
| `github_search_repos` | `query: string` | Search repos (user context) |
| `github_list_issues` | `owner`, `repo`, optional `state` | List issues |
| `github_get_file` | `owner`, `repo`, `path`, optional `ref` | Text file; reject huge/binary |
| `github_search_code` | `query: string` | Code search; handle 403 rate limit |

### Gmail (`gmail_`)

| Tool | Args | Behavior |
|------|------|----------|
| `gmail_search` | `query: string` | messages.list `q=` |
| `gmail_get_message` | `message_id: string` | Get payload; prefer text/plain |
| `gmail_list_labels` | (none) | labels.list |

### Google Drive (`gdrive_`)

| Tool | Args | Behavior |
|------|------|----------|
| `gdrive_search` | `query: string` | files.list |
| `gdrive_get_metadata` | `file_id: string` | files.get |
| `gdrive_export_text` | `file_id: string` | export Google Docs/Sheets to text/csv; error on non-exportable |

### Google Calendar (`gcal_`)

| Tool | Args | Behavior |
|------|------|----------|
| `gcal_list_calendars` | (none) | calendarList.list |
| `gcal_list_events` | `calendar_id`, `time_min`, `time_max` | events.list |
| `gcal_create_event` | `calendar_id`, `summary`, `start`, `end`, optional `description` | events.insert |

### Outlook (`outlook_`)

| Tool | Args | Behavior |
|------|------|----------|
| `outlook_search` | `query: string` | list messages with $search / filter |
| `outlook_get_message` | `message_id: string` | get message |
| `outlook_list_folders` | (none) | mailFolders |

### Outlook Calendar (`outcal_`)

| Tool | Args | Behavior |
|------|------|----------|
| `outcal_list_calendars` | (none) | /me/calendars |
| `outcal_list_events` | `time_min`, `time_max`, optional `calendar_id` | calendarView or events |
| `outcal_create_event` | `subject`, `start`, `end`, optional `body` | POST /me/events |

### Registry wiring (`index.ts`)

```ts
export function getConnectionTools(conn: ConnectionRow) {
  switch (conn.provider) {
    case "notion": return NOTION_TOOLS;
    case "github": return GITHUB_TOOLS;
    case "gmail": return GMAIL_TOOLS;
    case "google_drive": return GDRIVE_TOOLS;
    case "google_calendar": return GCAL_TOOLS;
    case "outlook": return OUTLOOK_TOOLS;
    case "outlook_calendar": return OUTCAL_TOOLS;
    default: return [];
  }
}

export async function dispatchConnectionTool(conn, toolName, args) {
  switch (conn.provider) {
    case "notion": return dispatchNotionTool(...);
    case "github": return dispatchGithubTool(...);
    // ...
    default: return { content: `Unknown provider: ${conn.provider}` };
  }
}
```

Prefer importing tools/dispatch from per-provider modules to keep `index.ts` thin.

---

## 11. OAuth route template (copy Notion)

### Authorize (`src/app/api/connections/{provider}/authorize/route.ts`)

Must:

1. `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`
2. `getSessionUser()` → 401 if missing
3. Read client id from env → 500 if missing
4. `origin = resolvePublicOrigin(req.headers, getConfiguredAuthUrl())`
5. `redirectUri = \`${origin}/api/connections/{provider}/callback\``
6. `state = user.id`
7. `Response.redirect(authUrl)`

### Callback (`.../callback/route.ts`)

Must:

1. Session required → `redirect("/login")` if not
2. On provider `error` param → `redirect("/?connection_error={provider}_denied")`
3. `code` + `state === user.id` or 400
4. Same origin derivation as authorize for `redirect_uri` in token exchange
5. Exchange code; `db.insert(connections).values({...})`
6. Success → `redirect("/?connection_success={provider}")`
7. Catch → log without tokens → `redirect("/?connection_error={provider}_failed")`

**Provider path segment must match table** (use folder names: `google_drive`, `google_calendar`, `outlook_calendar`).

---

## 12. Settings / env wiring

### `src/app/api/settings/route.ts`

Mirror Notion:

| Body / JSON field | Env var | Masking |
|-------------------|---------|---------|
| `googleConnectionsClientId` | `GOOGLE_CONNECTIONS_CLIENT_ID` | plaintext ok |
| `googleConnectionsClientSecret` | `GOOGLE_CONNECTIONS_CLIENT_SECRET` | never return; `hasGoogleConnectionsClientSecret` |
| `githubConnectionsClientId` | `GITHUB_CONNECTIONS_CLIENT_ID` | plaintext ok |
| `githubConnectionsClientSecret` | `GITHUB_CONNECTIONS_CLIENT_SECRET` | never return; `has…` |
| `microsoftClientId` | `MICROSOFT_CLIENT_ID` | plaintext ok |
| `microsoftClientSecret` | `MICROSOFT_CLIENT_SECRET` | never return; `has…` |
| `microsoftTenantId` | `MICROSOFT_TENANT_ID` | plaintext; default display `common` |

GET returns empty secret strings + `has*` booleans (copy Notion test in `route.test.ts`).

### Settings UI sections

1. **Notion** — keep as-is  
2. **Google Connections** — shared id/secret fields + 3 Connect links  
3. **GitHub** — id/secret + Connect  
4. **Microsoft** — id/secret/tenant + 2 Connect links  

Connect button enabled only when corresponding client id is present (after save), same as Notion.

List rows: show `provider` badge + `workspaceName` + disconnect (existing DELETE).

### i18n

- Add keys for all new labels/hints/buttons in **Japanese first**, then English (`src/lib/i18n/dictionaries.ts`).
- Chat status: prefer one generic key `chat.statusToolConnection` with `{tool}` param, or per-provider keys.

### Thread picker (`ChatWindow.tsx`)

- Existing multi-select works if list returns all providers.
- Improve label: `${provider}: ${workspaceName}` so users distinguish Gmail vs Drive.

---

## 13. Security checklist (every provider)

- [ ] No token/secret in logs (`logger` only safe fields)
- [ ] No tokens in GET `/api/connections` or GET `/api/settings`
- [ ] All DB ops filter `userId`
- [ ] CSRF `state === user.id`
- [ ] Fixed API hostnames only (no user-controlled base URL)
- [ ] Tool writes limited to calendar create only in v1
- [ ] Truncate large API bodies before returning to model

---

## 14. Phases & tasks (execute in order)

### Phase 0 — Documentation discovery

Do this **before** coding API URL paths for each family. Use web docs if needed.

- [ ] **0.1 Google:** confirm auth URL, token URL, offline refresh, Gmail list/get, Drive list/get/export MIME map, Calendar list/insert, exact scopes  
- [ ] **0.2 GitHub:** confirm OAuth + refresh token option, REST endpoints, required headers, rate limit behavior  
- [ ] **0.3 Microsoft:** confirm v2 authorize/token, Graph mail + calendar paths, `common` tenant, scopes  
- [ ] **0.4 Repo freeze:** re-read all Canonical copy sources; note line numbers if they shifted  

**Exit criteria:** short “Allowed APIs (verified)” notes exist (in this file footer or module headers). No coding of live endpoints before that for the family you implement.

---

### Phase 1 — Platform hardening

- [ ] **1.1** Schema + migration (`scopes`, `expiresAt`, nullable `refreshToken`, expanded enum)  
- [ ] **1.2** `types.ts` + `provider-map.ts` + unit tests  
- [ ] **1.3** Refactor `index.ts` types; keep Notion tools working  
- [ ] **1.4** Fix chat route multi-provider dispatch + access-only token persist  
- [ ] **1.5** Stubs or full shared `google-oauth.ts` / `microsoft-oauth.ts` with **mocked fetch tests** (can complete helpers fully in family phases if preferred, but chat dispatch must not stay Notion-only)

**Exit criteria:**

```bash
bun run test
bun run typecheck
```

Grep must find **no** `connectionRows[0]` in connection-tool dispatch path.

---

### Phase 2 — GitHub vertical slice (first complete provider)

- [ ] **2.1** `github.ts`: exchange, refresh if available, `callGithubApi`, tools, dispatch  
- [ ] **2.2** authorize + callback routes  
- [ ] **2.3** settings API + SettingsModal + i18n for GitHub only  
- [ ] **2.4** unit tests (mock fetch) for token exchange + each tool formatter  
- [ ] **2.5** `.env.example` entries for GitHub  

**Exit criteria:** with mock tests green; manual OAuth optional if credentials unavailable (document skip).

---

### Phase 3 — Google family

- [ ] **3.1** `google-oauth.ts` complete + tests  
- [ ] **3.2** gmail module + routes + tools + tests  
- [ ] **3.3** google-drive module + routes + tools + tests  
- [ ] **3.4** google-calendar module + routes + tools + tests  
- [ ] **3.5** Settings Google section (shared credentials, 3 buttons) + i18n + settings API  
- [ ] **3.6** `.env.example` Google connection vars  

**Exit criteria:** all three providers registered in `getConnectionTools` / dispatch; tests green.

---

### Phase 4 — Microsoft family

- [ ] **4.1** `microsoft-oauth.ts` + tests  
- [ ] **4.2** outlook mail + routes + tools + tests  
- [ ] **4.3** outlook-calendar + routes + tools + tests  
- [ ] **4.4** Settings Microsoft section + i18n + settings API  
- [ ] **4.5** `.env.example` Microsoft vars  

**Exit criteria:** same as Phase 3 for two providers.

---

### Phase 5 — UI polish

- [ ] **5.1** Connections list shows provider labels for all  
- [ ] **5.2** ChatWindow picker labels improved  
- [ ] **5.3** Help topics optional but recommended (one topic per family or one “Connections” overview)  
- [ ] **5.4** SettingsModal tests updated for new fields  
- [ ] **5.5** success/error query params work for new provider names (strip still works)

---

### Phase 6 — Documentation

Update (EN content; README also JA):

- [ ] `docs/tool-calling.md` — Connections section for 6 providers; remove “Notion only”; fix dispatch docs  
- [ ] `docs/api-routes.md` — new routes  
- [ ] `docs/authentication.md` — login Google vs connections Google  
- [ ] `docs/database.md` — connections columns  
- [ ] `docs/glossary.md` — **replace** “do not build first-party OAuth for Drive/GitHub” with Connection vs MCP guidance aligned to this plan  
- [ ] `docs/frontend.md` — Settings connections sections  
- [ ] `docs/settings-env.md` if present  
- [ ] `README.md` + `README.ja.md` (parity) — feature bullet + env table + setup outline  
- [ ] Follow `skill://readme-update-guide` / `.agents/skills/readme-update-guide/SKILL.md`

---

### Phase 7 — Verification

- [ ] `bun run test`  
- [ ] `bun run typecheck`  
- [ ] Grep guards:
  - no `connectionRows[0]` for connection tools
  - no logging of `access_token` / `refresh_token` / client secrets
  - all 6 prefixes present in provider-map
- [ ] Manual smoke matrix (mark N/A if no credentials):

| Provider | Connect | Tool read | Refresh path | Disconnect |
|----------|---------|-----------|--------------|------------|
| notion | | | | |
| github | | | | |
| gmail | | | | |
| google_drive | | | | |
| google_calendar | | | | |
| outlook | | | | |
| outlook_calendar | | | | |

- [ ] Regression: Google **login** still works; remote MCP still works  

---

## 15. Test requirements (minimum)

| Area | File example | What to assert |
|------|--------------|----------------|
| provider-map | `provider-map.test.ts` | all prefixes resolve; unknown null |
| google-oauth | `google-oauth.test.ts` | exchange body; 401 refresh once; no secret in thrown messages if avoidable |
| github tools | `github.test.ts` | formats list; truncates large file |
| gmail / drive / cal | `*.test.ts` | mock API JSON → stable tool strings |
| outlook / outcal | `*.test.ts` | same |
| settings | `settings/route.test.ts` | secrets masked for new keys |
| optional authorize | `.../authorize/route.test.ts` | 401 without session; 500 without client id |

All lib/api tests: first line `// @vitest-environment node`.

Use `vi.stubGlobal("fetch", vi.fn())` / `vi.restoreAllMocks()` — no real network in CI.

---

## 16. Anti-patterns (reject these)

| Do not | Do instead |
|--------|------------|
| Invent OAuth URLs from memory without Phase 0 | Verify docs; then hardcode constants |
| Use `GOOGLE_CLIENT_ID` for Gmail API | `GOOGLE_CONNECTIONS_*` |
| Store connection tokens in Auth.js `accounts` | `connections` table only |
| `connectionRows[0]` | find by provider |
| Require both new access + refresh to persist | Persist access alone |
| Dynamic user-supplied API base URL | Fixed official hosts |
| One mega Google connection for all products | 3 providers / 3 rows |
| Edit old drizzle SQL files | generate new migration |
| Put tests under `__tests__/` | co-locate `*.test.ts` |
| Log tokens | redacted logger only |
| Implement via MCP “for now” | This plan is OAuth Connections |
| Massive tool surface in v1 | Stick to tool tables in §10 |

---

## 17. Redirect URIs to document for users

Register for each origin (localhost + tunnel if used):

```
{origin}/api/connections/gmail/callback
{origin}/api/connections/google_drive/callback
{origin}/api/connections/google_calendar/callback
{origin}/api/connections/github/callback
{origin}/api/connections/outlook/callback
{origin}/api/connections/outlook_calendar/callback
```

Keep existing:

```
{origin}/api/auth/callback/google
{origin}/api/connections/notion/callback
```

---

## 18. Commit strategy (suggested)

Implementer may split commits:

1. `feat(connections): multi-provider dispatch + schema for oauth connectors`  
2. `feat(connections): add GitHub OAuth connector`  
3. `feat(connections): add Google Gmail Drive Calendar connectors`  
4. `feat(connections): add Outlook mail and calendar connectors`  
5. `docs: document OAuth connectors and update glossary`  

Ask user before `git push` unless they already authorized push.

---

## 19. Implementation status (update me)

| Area | Status | Notes |
|------|--------|--------|
| Phase 0 | Done | All 3 provider families verified, §20 filled |
| Phase 1 | Done | Schema, provider-map, multi-provider dispatch, access-only persist |
| Phase 2 GitHub | Done | OAuth App (no refresh), 4 tools, 18 tests |
| Phase 3 Google | Done | 3 products, shared google-oauth helper, 16 tests |
| Phase 4 Microsoft | Done | 2 products, shared microsoft-oauth helper, 11 tests |
| Phase 5 UI | Done | SettingsModal multi-provider, ChatWindow labels |
| Phase 6 Docs | Done | tool-calling, glossary, database, api-routes, README EN/JA |
| Phase 7 Verify | Done | 89 test files / 1122 pass, typecheck clean, grep guards pass |

---

## 20. Allowed APIs (verified) — implementer fills during Phase 0

### Google

- Auth URL: `https://accounts.google.com/o/oauth2/v2/auth`
- Token URL: `https://oauth2.googleapis.com/token` (same URL for code-exchange AND refresh; form-urlencoded)
- Authorize params: `client_id`, `redirect_uri`, `response_type=code`, `scope` (space-sep), `state`, `access_type=offline`, `prompt=consent`
- Token response: `access_token`, `expires_in` (seconds, ~3600), `refresh_token` (first consent only), `scope` (granted subset), `token_type=Bearer`
- Refresh: persist new `refresh_token` if returned (rotation possible)
- Scopes confirmed:
  - Gmail: `https://www.googleapis.com/auth/gmail.readonly`
  - Drive: `https://www.googleapis.com/auth/drive.readonly`
  - Calendar read: `https://www.googleapis.com/auth/calendar.readonly`
  - Calendar events r/w: `https://www.googleapis.com/auth/calendar.events`
- Gmail endpoints (base `https://gmail.googleapis.com/gmail/v1`, userId=`me`):
  - `GET /users/me/messages?q=&maxResults=` → `{messages:[{id,threadId}], nextPageToken}`
  - `GET /users/me/messages/{id}?format=metadata` (metadataHeaders limit)
  - `GET /users/me/labels`
- Drive endpoints (base `https://www.googleapis.com/drive/v3`):
  - `GET /files?q=&pageSize=&fields=`
  - `GET /files/{fileId}` (metadata; `alt=media` for binary)
  - `GET /files/{fileId}/export?mimeType=` (Docs→`text/plain`, Sheets→`text/csv`, Slides→`text/plain`; REST param is `mimeType` not `exportMimeType`; max 10MB)
- Calendar endpoints (base `https://www.googleapis.com/calendar/v3`):
  - `GET /users/me/calendarList`
  - `GET /calendars/{calendarId}/events?timeMin=&timeMax=&singleEvents=true&orderBy=startTime`
  - `POST /calendars/{calendarId}/events` (body: start, end, summary, description; query: `sendUpdates=none`)
- Notes: `prompt=consent` forces consent screen every time — use only on initial connect. refresh_token returned only first consent unless prompt=consent re-forces. `calendar.events` (not `.readonly`) for create-event. Gmail `q=` needs `gmail.readonly` (not `metadata`). Verified 2026-07-17 vs developers.google.com.

### GitHub

- Auth URL: `https://github.com/login/oauth/authorize`
- Token URL: `https://github.com/login/oauth/access_token` (POST, MUST send `Accept: application/json` header — default is form-encoded)
- Scopes confirmed: `read:user` (public profile), `repo` (full r/w public+private repos). Space-delimited in authorize.
- REST endpoints used (base `https://api.github.com`):
  - `GET /search/repositories?q=&per_page=`
  - `GET /repos/{owner}/{repo}/issues?state=open|closed|all&per_page=`
  - `GET /repos/{owner}/{repo}/contents/{path}?ref=` — **slashes in {path} MUST be `%2F`-encoded**; else 404. Use `encodeURIComponent` per segment then join with `%2F`.
  - `GET /search/code?q=` — requires auth, 10 req/min, `repo` scope for private repos
  - `GET /user` — authenticated user profile (login, name, avatar_url, email)
- Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28` (default, supported through 2028; `2026-03-10` is newer), `User-Agent: UmansChat` (REQUIRED — omission rejected, invalid → 403)
- Token response (with Accept: application/json): `access_token` (prefix `gho_`), `token_type` (lowercase `bearer`), `scope` (comma-sep). No `expires_in`, no `refresh_token`.
- Notes: **OAuth Apps do NOT support refresh tokens.** Tokens are long-lived until revoked. Handle 401/403 as re-auth needed (no refresh flow). PKCE (`code_challenge`/`code_challenge_method=S256`) strongly recommended by GitHub — add for security. Rate limit: 5000/hr auth, 30/min search, 10/min code search. `read:user` sufficient for /user public profile display. Verified 2026-07-17 vs docs.github.com.

### Microsoft

- Auth URL: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` (tenant = `MICROSOFT_TENANT_ID` or `common`)
- Token URL: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` (same URL for code-exchange AND refresh; form-urlencoded)
- Tenant default: `common` (works for multi-tenant personal+work accounts); also `organizations`, `consumers`, or specific GUID
- Authorize params: `client_id`, `redirect_uri`, `response_type=code`, `scope` (space-sep), `state`. `response_mode=query` is the default — can omit. `prompt=select_account` optional.
- Token exchange body: `client_id`, `client_secret`, `code`, `redirect_uri`, `grant_type=authorization_code`, `scope`
- Refresh body: `client_id`, `client_secret`, `refresh_token`, `grant_type=refresh_token`, `scope` (`scope` optional, `redirect_uri` NOT required on refresh)
- Token response: `access_token`, `refresh_token`, `expires_in` (seconds), `scope` (granted), `token_type=Bearer`
- Scopes confirmed: `offline_access` (REQUIRED for refresh tokens), `User.Read`, `Mail.Read`, `Calendars.Read`, `Calendars.ReadWrite`. Short names default to `https://graph.microsoft.com/<Scope>`.
- Graph endpoints used (base `https://graph.microsoft.com/v1.0`):
  - Mail: `GET /me/messages?$search="query"` (KQL syntax, sorted by sent date; NO ConsistencyLevel header needed for messages), `GET /me/messages/{id}`, `GET /me/mailFolders`
  - Calendar: `GET /me/calendars`, `GET /me/calendarView?startDateTime=&endDateTime=` (calendarView not events; start+end required), `GET /me/calendars/{id}/calendarView?startDateTime=&endDateTime=`, `POST /me/events`, `POST /me/calendars/{id}/events`
  - Profile: `GET /me` (displayName, mail, userPrincipalName; needs User.Read)
- Headers: `Authorization: Bearer <token>`. `ConsistencyLevel: eventual` only needed for directory objects (users/groups), NOT for messages.
- Notes: Single app registration + one client_id/secret serves BOTH outlook mail and calendar — different scopes at authorize time via dynamic/incremental consent. `offline_access` must always be included to get refresh tokens. Refresh token lifetime ~90 days. Verified 2026-07-17 vs learn.microsoft.com.

---

## 21. Progress log

| Date | Who | Note |
|------|-----|------|
| 2026-07-17 | planner | Plan written as handoff for separate implementer model/session |
| 2026-07-17 | planner | Reworked for zero-context execution: session split, exit criteria, anti-patterns, exact env/tool tables |

---

## 22. Start here checklist (first message for implementer agent)

Copy this into a new agent session:

```
Implement docs/superpowers/plans/2026-07-17-oauth-connectors.md
Rules:
- You are the implementer; plan is source of truth.
- Start Phase 0 + Phase 1 only in the first session unless told otherwise.
- Copy Notion patterns from paths listed in §3.
- Do not use MCP instead of OAuth Connections.
- Do not touch Auth.js Google login credentials for API connectors.
- After Phase 1: bun run test && bun run typecheck must pass.
- Check off tasks in the plan file as you complete them.
```
