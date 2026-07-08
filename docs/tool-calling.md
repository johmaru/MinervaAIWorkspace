Tool calling, MCP integration, and connections (Notion) — how UmansChat routes tool calls, probes for model support, sanitizes rogue markup, and integrates external tool providers.

## Relevant source files

- `src/app/api/chat/route.ts` — `streamCompletion()` tool-use loop, `STREAM_TOOLS`, `buildSearchContext()`, tool-call markup workaround
- `src/lib/toolProbe.ts` — startup tool-support probe (`probeToolSupport`, `warmupToolProbe`, `resetToolProbeCache`)
- `src/lib/toolCallSanitizer.ts` — `hasToolCallMarkup`, `sanitizeToolCallMarkup`
- `src/lib/mcpClient.ts` — MCP client: connect, list tools, call tools, name format
- `src/lib/connections/index.ts` — connection tool definitions and dispatch (`getConnectionTools`, `dispatchConnectionTool`)
- `src/lib/connections/notion.ts` — Notion OAuth: token exchange, refresh, API calls
- `src/lib/searchDecision.ts` — search decision router (`decideSearch`, `buildHeuristicDecision`)
- `src/app/api/mcp-servers/route.ts` — MCP server CRUD API
- `src/app/api/connections/route.ts` — connection list/delete API
- `src/app/api/connections/notion/authorize/route.ts` — Notion OAuth authorize redirect
- `src/app/api/connections/notion/callback/route.ts` — Notion OAuth callback + token exchange

## Overview

UmansChat supports two parallel tool-calling paths, gated by a startup probe that determines whether the configured LLM stably supports function calling:

- **Path A (pre-search):** For models that *don't* support function calling, the server decides whether to search *before* streaming, injects results as a system message, and the model answers in a single stream.
- **Path B (in-stream function calling):** For models that *do* support function calling, tools are passed to `streamCompletion()`, which runs a multi-round tool-use loop with up to `MAX_TOOL_ROUNDS = 3` iterations.

On top of these built-in tools, two extensibility mechanisms allow external tools:

- **MCP (Model Context Protocol) servers** — registered per-user, enabled per-thread, connected at request time with HTTP or stdio transports.
- **Connections (OAuth-based providers)** — currently Notion only, with OAuth token management and auto-refresh.

---

## Tool Support Probe

**File:** `src/lib/toolProbe.ts`

### Why it exists

GLM-5.2 (the default model) has a track record of unstable `response_format`, and tool-calling support may be similarly unstable. Rather than assuming every OpenAI-compatible model supports function calling, UmansChat probes the model once at startup and gates all tool-calling behavior on the result.

### How it works

`probeToolSupport(llm, model)` (line 61) sends a single non-streaming request with a dummy `search_web` tool definition (`PROBE_TOOLS`, lines 27–42) and the message:

```
Return the string 'probe-ok' without calling any tool. Do not call any function.
```

The decision logic (`runProbe`, line 76):

| Condition | Result |
|-----------|--------|
| `finish_reason === "stop"` **and** content contains `"probe-ok"` | `{ supported: true }` |
| Model called the tool unprompted (`tool_calls.length > 0`) | `{ supported: false }` |
| Error, timeout, or empty choice | `{ supported: false }` |

A model that calls the tool when explicitly told not to is considered unsupported — it cannot reliably follow tool-use instructions.

### Caching

Results are cached in-process via the `cached` variable (line 15). Once the probe completes, subsequent calls return the cached `ToolSupport` object without re-probing. `resetToolProbeCache()` (line 19) discards the cache — called when LLM settings change (model, base URL, API key) via the settings API.

A `probePromise` (line 16) deduplicates concurrent calls: if two requests arrive before the first probe completes, both await the same promise.

### Warmup

`warmupToolProbe()` (line 121) starts the probe in the background at process startup via `queueMicrotask` (line 124). This hides the ~750ms probe latency before the first real request. The microtask delay ensures environment variables are loaded before the probe runs. Warmup failure is harmless — the probe is retried on the first `probeToolSupport()` call.

In the chat route, the probe is started early in the POST handler (route.ts:170–172) to overlap with pre-stream parallel work:

```typescript
const toolSupportPromise = body.rapid
  ? Promise.resolve(null)
  : probeToolSupport(llm, finalModel).catch(() => null);
```

The result is awaited later (route.ts:353), by which point the probe has likely completed.

---

## Path A: Pre-Search (Non-Tool-Supporting Models)

When `probeToolSupport` returns `{ supported: false }`, the model cannot do function calling. Instead, the server decides *whether* to search **before** streaming begins, fetches results, and injects them as a system message. The model then answers in a single stream with no tools.

### Search decision router

**File:** `src/lib/searchDecision.ts`

`decideSearch(userMessage, model, locale, history)` (line 233) determines the `searchLevel`: `"none"`, `"wiki"`, or `"web"`.

#### Step 1: Heuristic decision (regex, no LLM call)

`buildHeuristicDecision(userMessage, locale)` (line 94) runs a series of regex patterns in priority order:

| Pattern | Matches | Decision |
|---------|---------|----------|
| `MEMORY_RECALL_PATTERN` | "何話した", "覚えてる", "what did we talk" | `null` (defer to LLM, typically no search) |
| `UNKNOWN_TERM_PATTERN` | "Xって何", "Xとは", "what is X", "tell me about X" | `searchLevel: "wiki"` — returns immediately, skips LLM |
| `NO_SEARCH_PATTERN` (if no explicit/volatile match) | code, translate, opinion, advice | `searchLevel: "none"` — returns immediately, skips LLM |
| `EXPLICIT_SEARCH_PATTERN` / `VOLATILE_INFO_PATTERN` | "最新", "レビュー", "price", "latest", "review" | `searchLevel: "web"` — returns immediately with queries |
| None of the above | — | `null` (defer to LLM router) |

Heuristic results for `"none"` and `"wiki"` short-circuit: they return immediately without an LLM call (searchDecision.ts:245–247). Only `"web"` heuristic results (and `null` deferrals) proceed to the LLM router.

#### Step 2: LLM router (only if heuristic is `null` or `web`)

A non-streaming completion with thinking disabled (`buildDisableReasoningParams`), using a detailed system prompt (line 19) instructing JSON-only output:

```json
{"searchLevel": "none" | "wiki" | "web", "reason": "...", "userNotice": "...", "queries": ["..."]}
```

**GLM-5.2 workaround:** `response_format: { type: "json_object" }` is deliberately *not* used — it's unstable on GLM-5.2 (causes empty content or timeouts). Instead, JSON is parsed from a plain completion after stripping markdown code fences (searchDecision.ts:221–223, 256–259). `parseDecision()` (line 173) handles fence-stripping and validation.

On parse failure or LLM error, falls back to the heuristic decision, or `{ searchLevel: "none" }` if no heuristic matched.

### Building the search context

**`buildSearchContext()`** (route.ts:675) uses the `SearchDecision` result:

| `searchLevel` | Action |
|---------------|--------|
| `"none"` or empty queries | Returns `null` — no search, no system message |
| `"wiki"` | Calls `searchWikipedia()` for up to 2 queries in parallel. On hit: system message with Wikipedia extract. On miss: system message noting "answer from training data." |
| `"web"` | Calls `searchWeb()` in parallel for up to `maxRounds` queries (env `WEB_SEARCH_MAX_ROUNDS`, default 1, max 5), `maxResults` per query (env `WEB_SEARCH_MAX_RESULTS`, default 3). Results are JSON-stringified into a system message. Each result's content is sliced to `SEARCH_RESULT_CONTENT_SLICE = 2000` chars. |

The resulting system message is placed into `buildFinalMessages()` and tells the model: "Search has been completed. Use this to answer directly. Do NOT attempt to search or scrape again."

### Client notification

During pre-search, the server emits `status` SSE events (e.g., "最新の情報をWebで確認します。") and `sources` events with the found URLs. See [Chat & Streaming](./chat-streaming.md) for the full SSE event protocol.

---

## Path B: In-Stream Function Calling (Tool-Supporting Models)

When `probeToolSupport` returns `{ supported: true }`, the search system message is **excluded** from the message array (route.ts:356–367) — the pre-search "search complete" message hinders the LLM's ability to reference tool-call results. Tools are then passed to `streamCompletion()`.

### Built-in tools

**`STREAM_TOOLS`** (route.ts:1050–1095) defines three built-in tools:

| Tool | Parameters | Description |
|------|------------|-------------|
| `scrape_webpage` | `url: string` (required) | Fetch and read the content of a web page. Used when the user shares a URL or the model needs to read a specific page. |
| `search_web` | `query: string` (required) | Search the web for current information or unfamiliar terms. Uses SearXNG + Scrapling scraper. |
| `search_wikipedia` | `query: string` (required) | Look up a Wikipedia article for factual information about named entities. Faster than `search_web`. |

These tool names **never** contain `__` (the MCP separator), which is how built-in tools are distinguished from MCP tools during dispatch.

### The `streamCompletion()` tool-use loop

**File:** route.ts:1099–1367

```
MAX_TOOL_ROUNDS = 3
```

The function runs a `while (true)` loop (line 1143):

1. **Round guard:** `useToolsThisRound = useTools && rounds < MAX_TOOL_ROUNDS` (line 1144). `useTools` is `true` only when `toolSupport?.supported === true` and a `send` function is provided.

2. **Create streaming completion** (line 1146):
   - When tools are active: passes `tools` (STREAM_TOOLS + extraTools) + `tool_choice: "auto"`, and uses `disableReasoningParams` (thinking suppressed during tool rounds for latency).
   - When tools are not active (round limit reached or unsupported): no `tools` key, uses `reasoning_effort` if the model supports it.

3. **Accumulate `tool_calls` deltas** (lines 1163–1202): OpenAI streams tool calls split across chunks. A `toolCallAccumulator` indexed by `tc.index` merges `id`, `name`, and `arguments` incrementally:

   ```typescript
   const toolCallAccumulator: Record<number, { id: string; name: string; arguments: string }> = {};
   // For each chunk's tool_calls delta:
   if (tc.id) existing.id = tc.id;
   if (tc.function?.name) existing.name += tc.function.name;
   if (tc.function?.arguments) existing.arguments += tc.function.arguments;
   ```

4. **No tool calls → break** (line 1205): If `hadToolCalls` is false or `useToolsThisRound` is false, the loop exits — the model produced a final answer.

5. **Execute tool calls** (lines 1232–1347): For each accumulated tool call, dispatch based on the tool name:

   | Tool name pattern | Dispatch | Status message |
   |-------------------|----------|----------------|
   | `scrape_webpage` | `scrapeUrl(url)`, content sliced to 2000 chars | "URLの内容を取得しています。" |
   | `search_web` | `searchWeb(query, maxResults, timeRange)` | "Webで検索しています。" |
   | `search_wikipedia` | `searchWikipedia(query)` | i18n: `chat.statusWikiLooking` |
   | Contains `__` (MCP) | `parseMcpToolFunctionName(name)` → `callMcpTool(conn, toolName, args)` | `MCP: {serverName}/{toolName} を実行中` |
   | Starts with `notion_` (connection) | `dispatchConnectionTool(conn, name, args)` | `Notion: {name} を実行中` |

6. **Append results to message history** (lines 1216–1356): The assistant message (with `tool_calls`) and each tool result (`role: "tool"`, `tool_call_id`, `content`) are appended to `currentMessages`.

7. **Emit sources and status** (lines 1359–1363): If any tool call produced sources, emit a `sources` SSE event. If `rounds >= MAX_TOOL_ROUNDS`, emit a status: "検索回数上限に達しました。"

8. **Loop:** The next iteration re-streams with the tool results in context. The model sees the tool outputs and either calls more tools (up to the round limit) or produces a final answer.

9. **After `MAX_TOOL_ROUNDS`:** `useToolsThisRound` becomes false, so the next iteration streams without tool definitions — the model must produce a final answer from whatever context it has.

### Reasoning suppression during tool rounds

When tools are active (`useToolsThisRound` is true), `disableReasoningParams` is used instead of `reasoning_effort` (route.ts:1150–1157). This suppresses thinking tokens during tool rounds to reduce latency. Reasoning is re-enabled for the final answer stream (after the round limit is reached).

---

## Tool Call Sanitizer

**File:** `src/lib/toolCallSanitizer.ts`

### The problem

Some models (notably GLM-5.2) that don't support function calling may still emit tool-call syntax as **plain text** in their output — e.g., fenced code blocks like ` ```search_web query="..."``` ` or XML tags like `<search_web>...</search_web>`. This breaks the UI: unclosed code fences or XML tags render incorrectly, and the model may halt generation after emitting the syntax.

### `hasToolCallMarkup(content)`

```typescript
export function hasToolCallMarkup(content: string): boolean
```

Returns `true` if the content contains any of:
- A code fence with a tool name: ` ```scrape_webpage ` or ` ```search_web `
- An XML tag: `<scrape_webpage`, `<search_web`
- A GLM/Qwen tool-call tag: `<tool_call`

Used on the server side (route.ts:393) to decide whether the re-stream workaround is needed.

### `sanitizeToolCallMarkup(content)`

```typescript
export function sanitizeToolCallMarkup(content: string): string
```

Strips all tool-call markup via 9 regex passes, handling **both complete and partial/streaming** forms:

| Format | Complete form | Streaming form (no closer) |
|--------|---------------|-----------------------------|
| Code fence | ` ```tool_name ... ``` ` → removed | ` ```tool_name ... ` (no closing fence) → removed |
| XML tag | `<tool_name>...</tool_name>` → removed | `<tool_name>...` (no closing tag) → removed |
| XML self-closing | `<tool_name ... />` → removed | — |
| XML incomplete opening | — | `<tool_name query="...` (no `>`) → removed |
| GLM/Qwen tool_call tag | `&lt;tool_call&gt;...&lt;/tool_call&gt;` — removed | `&lt;tool_call&gt;...` (no closer) and incomplete opening — removed |

After all passes, `.trim()` removes leading/trailing whitespace.

### The re-stream workaround

After streaming completes, if `hasToolCallMarkup(assistantContent)` is true (route.ts:390–427), the server:

1. **Sends a status event:** `send("status", { label: "検索結果に基づいて回答を生成しています。" })`
2. **Sanitizes the content:** `assistantContent = sanitizeToolCallMarkup(assistantContent)`
3. **Replaces the client's displayed content:** `send("replace_content", { content: assistantContent })` — the `replace_content` SSE event replaces (not appends) the assistant message content in the UI.
4. **Builds continuation messages:** The original `finalMessages` + the sanitized assistant content + a user message:

   > The previous response contained tool-call syntax which is not supported in this environment. Web search results have already been provided above — use them to answer directly. Do not output any tool-call, function-call, or XML-tag syntax. Answer the user's question now.

5. **Re-streams once:** `streamCompletion(continuationMessages)` — a single-shot regeneration with no tools passed (no `toolSupport`, `send`, or `extraTools`). The prompt explicitly forbids tool syntax, so no loop guard is needed.

This is a **single-shot** workaround — it runs at most once. There is no infinite loop risk.

### Client-side usage

`sanitizeToolCallMarkup` is also used client-side by `Markdown.tsx` (per the module docstring) to avoid rendering broken fences in the UI during streaming, before the server-side re-stream kicks in.

---

## MCP Integration

**File:** `src/lib/mcpClient.ts`

UmansChat integrates with external tool servers via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). MCP servers are registered per-user and enabled per-thread.

### Registration

MCP servers are managed via the CRUD API at `src/app/api/mcp-servers/route.ts`:

- **`GET /api/mcp-servers`** — list the user's servers (newest first).
- **`POST /api/mcp-servers`** — register a new server. Body: `{ name, transport, url?, command?, args?, env? }`.
  - `transport: "http"` requires `url`.
  - `transport: "stdio"` requires `command`.
- **`PATCH /api/mcp-servers/[id]`** — update a server.
- **`DELETE /api/mcp-servers/[id]`** — delete a server.

Servers are stored in the `mcpServers` table, scoped by `userId`.

### Transports

`connectMcpServer(config)` (mcpClient.ts:74) establishes a connection based on the transport type:

| Transport | How it connects | Fallback |
|-----------|-----------------|----------|
| `"http"` | `StreamableHTTPClientTransport` (MCP spec's Streamable HTTP) | Falls back to `SSEClientTransport` (legacy SSE) on failure |
| `"stdio"` | `StdioClientTransport` — spawns a child process with `command`, `args`, `env` | None |

For HTTP transport, the client first tries the Streamable HTTP transport. If that fails (server only supports legacy SSE), it falls back to the SSE transport with a warning log.

For stdio transport, a child process is spawned. This process lives for the duration of the request and is terminated when the connection is closed.

Connection failure is **non-blocking**: `connectMcpServer` returns `null`, and the caller skips that server. Other servers' tools are still available.

### Per-thread enabling

MCP servers are enabled on a per-thread basis via `thread.mcpServerIds` — a JSON array of server IDs stored on the thread. During chat (route.ts:244–272):

1. Read `activeMcpServerIds = thread.mcpServerIds ?? []`.
2. Fetch server configs from the DB scoped by `userId` and `inArray(id, activeMcpServerIds)`.
3. For each config: `connectMcpServer(config)` -> if successful, `listMcpTools(conn)`.
4. All tools from all connected servers are collected into `mcpTools`.

### Tool name format

MCP tools are namespaced to prevent collisions with built-in tools and tools from other MCP servers:

```
{serverName}__{toolName}
```

The `__` separator (`MCP_NAME_SEPARATOR`, mcpClient.ts:43) is chosen because built-in tool names (`scrape_webpage`, `search_web`, `search_wikipedia`) never contain `__`.

- **`mcpToolFunctionName(serverName, toolName)`** (line 49): builds the function name.
- **`parseMcpToolFunctionName(name)`** (line 57): splits at the *first* `__`. The `serverName` is everything before the first `__`; the `toolName` is everything after (and may itself contain `__`).

Example: a server named `"github"` with a tool `"create_issue"` becomes `"github__create_issue"`.

### Discovery and conversion to OpenAI format

`listMcpTools(conn)` (line 131) calls `conn.client.listTools()` and maps each MCP tool to an `McpTool` tagged with `serverId` and `serverName` for reverse lookup during dispatch.

`mcpToolsToOpenAIFormat(tools)` (line 181) converts `McpTool[]` to OpenAI `ChatCompletionTool[]`:

```typescript
{
  type: "function",
  function: {
    name: "github__create_issue",  // "{serverName}__{toolName}"
    description: tool.description || `${tool.serverName}/${tool.toolName}`,
    parameters: tool.inputSchema,
  },
}
```

These are merged with `STREAM_TOOLS` and connection tools into the `extraTools` array passed to `streamCompletion()` (route.ts:382).

### Dispatch during streaming

When the model calls an MCP tool during the `streamCompletion()` loop (route.ts:1294–1317):

1. Check if the tool name contains `__`.
2. `parseMcpToolFunctionName(tc.name)` -> `{ serverName, toolName }`.
3. Find the connection: `mcpConnections.find(c => c.serverName === parsed.serverName)`.
4. If found: `callMcpTool(conn, parsed.toolName, parsedArgs)` — calls the tool on the MCP server.
5. If not found: returns `"MCP server \"{serverName}\" not connected"`.

`callMcpTool` (line 157) calls `conn.client.callTool({ name, arguments })` and extracts text content from the response. If the content array has `type: "text"` entries, they are joined with `\n`. Otherwise, falls back to `JSON.stringify(content)`. On error, returns a descriptive error string (non-blocking).

### Request-scoped lifecycle

MCP connections are **request-scoped** — opened at the start of the stream and closed in the `finally` block (route.ts:478–480):

```typescript
// finally block (route.ts:468-487)
for (const conn of mcpConnections) {
  try { await conn.client.close(); } catch {}
}
```

For stdio servers, `conn.client.close()` terminates the child process. Connections do not persist across requests — each chat request re-connects to all enabled MCP servers.

---

## Connections (OAuth-Based Providers)

**Files:** `src/lib/connections/index.ts`, `src/lib/connections/notion.ts`

Connections are OAuth-based integrations with external services. Unlike MCP (which connects to tool servers), connections wrap a provider's REST API behind tool definitions, with automatic token management.

Currently, **Notion** is the only implemented provider.

### Notion OAuth flow

**Files:** `src/app/api/connections/notion/authorize/route.ts`, `src/app/api/connections/notion/callback/route.ts`, `src/lib/connections/notion.ts`

The OAuth 2.0 authorization code flow:

1. **Authorize** (`GET /api/connections/notion/authorize`): Redirects the user to Notion's authorization URL:

   ```
   https://api.notion.com/v1/oauth/authorize?client_id={NOTION_CLIENT_ID}&redirect_uri={callback}&response_type=code&owner=user&state={userId}
   ```

   The `state` parameter is set to the user's ID for CSRF prevention.

2. **Callback** (`GET /api/connections/notion/callback`): Notion redirects back with `?code=...&state=...`. The callback:
   - Verifies the user is logged in (`getSessionUser()`), redirects to `/login` if not.
   - Checks for `error` param (user denied authorization) -> redirects to `/?connection_error=notion_denied`.
   - Validates CSRF: `state` must match `user.id`.
   - Exchanges the code for tokens via `exchangeNotionCode(code, redirectUri)` (notion.ts:41), which POSTs to `https://api.notion.com/v1/oauth/token` with **HTTP Basic auth** (`NOTION_CLIENT_ID:NOTION_CLIENT_SECRET` base64-encoded).
   - Saves the tokens to the `connections` table: `accessToken`, `refreshToken`, `workspaceName`, `workspaceIcon`, `botId`, `ownerName`, `ownerEmail`.
   - Redirects to `/?connection_success=notion`.

3. **Environment variables required:** `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`. The redirect URI is `${AUTH_URL}/api/connections/notion/callback`.

### Notion tools

**`NOTION_TOOLS`** (connections/index.ts:61–115) defines three tools:

| Tool | Parameters | API call | Description |
|------|------------|----------|-------------|
| `notion_search` | `query: string` (required) | `POST /v1/search` with `{ query, page_size: 10 }` | Search pages and databases by title. Returns a formatted list of `[type] title — id: ...` |
| `notion_get_page` | `page_id: string` (required) | `GET /v1/pages/{page_id}` | Get a page's properties and metadata. Returns raw JSON. |
| `notion_get_blocks` | `block_id: string` (required) | `GET /v1/blocks/{block_id}/children?page_size=100` | Get a page's content blocks. Returns formatted `[block_type] text` lines. |

All Notion API calls use `Notion-Version: 2026-03-11` header and `Bearer {accessToken}` auth.

### Token refresh on 401

**`callNotionApi(accessToken, refreshToken, method, path, body?)`** (notion.ts:94) wraps every Notion API call with automatic token refresh:

1. Make the API call with the current `accessToken`.
2. If the response is `401 Unauthorized`:
   - Call `refreshNotionToken(refreshToken)` — POSTs to the token URL with `grant_type: "refresh_token"`. The old refresh token is invalidated; a new one is returned.
   - Retry the API call with the new access token.
   - Return the new tokens (`newAccessToken`, `newRefreshToken`) to the caller.
3. If refresh fails, return `{ ok: false, error }`.

**Persistence:** When `dispatchConnectionTool` returns refreshed tokens, the chat route persists them to the DB (route.ts:1333–1341):

```typescript
if (result.newAccessToken && result.newRefreshToken) {
  await db.update(connections)
    .set({ accessToken: result.newAccessToken, refreshToken: result.newRefreshToken, updatedAt: new Date() })
    .where(eq(connections.id, conn.id));
}
```

Persistence errors are silently ignored — the token will be refreshed again on the next call.

### Per-thread enabling

Connections are enabled per-thread via `thread.connectionIds` — a JSON array of connection IDs. During chat (route.ts:277–289):

1. Read `activeConnectionIds = thread.connectionIds ?? []`.
2. `loadConnections(user.id, activeConnectionIds)` — fetches connection rows from the DB (with `accessToken` and `refreshToken`).
3. For each connection: `getConnectionTools(conn)` — returns the provider's tool definitions.
4. All tools are collected into `connectionTools` and merged into `extraTools`.

Unlike MCP, connections are **stateless** HTTP APIs — no persistent connection is opened. The `ConnectionRow` (with tokens) is passed to `streamCompletion()` as `connectionRows`, and used during tool dispatch.

### Dispatch during streaming

When the model calls a connection tool (route.ts:1318–1344):

1. Check if the tool name starts with `notion_`.
2. Use the first matching connection row (Notion is currently the only provider).
3. `dispatchConnectionTool(conn, tc.name, connArgs)` — routes to `dispatchNotionTool` based on `conn.provider`.
4. If refreshed tokens are returned, persist them to the DB.

---

## Search Decision Summary

The search decision system determines *whether* and *how* to search, producing a `searchLevel` that drives both Path A (pre-search) and informs the model in Path B:

```
searchLevel: "none" | "wiki" | "web"
```

| Level | Meaning | When used |
|-------|---------|-----------|
| `"none"` | No search needed | Code, translation, opinions, advice, memory recall |
| `"wiki"` | Wikipedia lookup | Unknown terms, named entities, "what is X", biographical questions |
| `"web"` | Full web search | Latest/current info, prices, reviews, schedules, explicit search requests |

### Decision flow

```
User message
    |
    v
buildHeuristicDecision (regex, no LLM)
    |
    +-- MEMORY_RECALL_PATTERN -> null (defer to LLM)
    +-- UNKNOWN_TERM_PATTERN -> { searchLevel: "wiki" } -> return immediately
    +-- NO_SEARCH_PATTERN -> { searchLevel: "none" } -> return immediately
    +-- EXPLICIT_SEARCH / VOLATILE_INFO -> { searchLevel: "web" } -> return immediately
    +-- no match -> null (defer to LLM)
    |
    v
LLM router (if heuristic is null or web)
    |
    +-- JSON parsed successfully -> use LLM decision
    +-- parse error / LLM error -> fall back to heuristic or { searchLevel: "none" }
```

The heuristic runs first and short-circuits for `"none"` and `"wiki"` results — no LLM call is made. Only `"web"` heuristic results and `null` deferrals proceed to the LLM router for query refinement.

---

## Extensibility: Adding New Connection Providers

The connections module is designed for extensibility. The module docstring (connections/index.ts:9–17) documents the steps:

### Steps to add a new provider

1. **Add a provider branch to `getConnectionTools(conn)`** (line 52): Return the provider's tool definitions (OpenAI `ChatCompletionTool[]` format) when `conn.provider === "your_provider"`.

2. **Add a provider branch to `dispatchConnectionTool(conn, toolName, args)`** (line 121): Route to a `dispatchYourProviderTool` function when `conn.provider === "your_provider"`.

3. **Use a tool name prefix** to avoid collisions: e.g., `notion_`, `google_`, `github_`. The dispatch logic in `streamCompletion()` uses prefix matching (route.ts:1318: `tc.name.startsWith("notion_")`) to identify connection tools.

4. **Implement OAuth** (if needed): Create a provider module at `src/lib/connections/{provider}.ts` with:
   - `exchange{Provider}Code(code, redirectUri)` — authorization code to token exchange.
   - `refresh{Provider}Token(refreshToken)` — token refresh.
   - `call{Provider}Api(accessToken, refreshToken, method, path, body?)` — API wrapper with 401 auto-refresh-and-retry.

5. **Add OAuth routes** at `src/app/api/connections/{provider}/authorize/route.ts` and `src/app/api/connections/{provider}/callback/route.ts`.

6. **Add the provider to the connections table**: The `connections` table has a `provider` text column — no schema migration needed for a new provider string.

### Example skeleton

```typescript
// src/lib/connections/index.ts

export function getConnectionTools(conn: ConnectionRow): ChatCompletionTool[] {
  if (conn.provider === "notion") return NOTION_TOOLS;
  if (conn.provider === "github") return GITHUB_TOOLS;  // new
  return [];
}

export async function dispatchConnectionTool(conn, toolName, args) {
  if (conn.provider === "notion") return dispatchNotionTool(conn, toolName, args);
  if (conn.provider === "github") return dispatchGithubTool(conn, toolName, args);  // new
  return { content: `Unknown provider: ${conn.provider}` };
}
```

### Dispatch matching in `streamCompletion()`

Currently, the dispatch in `streamCompletion()` matches connection tools by prefix (route.ts:1318):

```typescript
} else if (tc.name.startsWith("notion_") && connectionRows && connectionRows.length > 0) {
  const conn = connectionRows[0];
  // ...
}
```

When adding a second provider, this matching logic must be extended to route by the new prefix. Since Notion is currently the only provider, `connectionRows[0]` is used directly. With multiple providers, you would filter by provider based on the tool name prefix.

---

## Tool Calling in Different Modes

| Mode | Tool probe | Pre-search (Path A) | In-stream tools (Path B) | MCP | Connections |
|------|-----------|---------------------|--------------------------|-----|-------------|
| **Normal** | Runs | If unsupported | If supported | Enabled | Enabled |
| **Rapid** | Skipped (`Promise.resolve(null)`) | Skipped | No tools passed | Skipped | Skipped |
| **Dual** | Runs | Excluded for tool-supporting models | Not passed to synthesis stream | Tools loaded but not passed to `streamCompletion` | Same as MCP |

In **rapid mode**, `streamCompletion()` is called with no `toolSupport`, `send`, `extraTools`, or `mcpConnections` — a pure LLM round-trip optimized for latency.

In **dual mode**, the dual-model flow (cross-review or debate) runs before the final synthesis stream. The synthesis stream does not receive tools, so dual mode + tool-supporting models means the final answer has no in-stream tool calling. See [Chat & Streaming](./chat-streaming.md) for dual-model details.

---

## See also

- [Chat & Streaming](./chat-streaming.md) — SSE event protocol, `streamCompletion()` in the context of the full chat pipeline, branching model, dual-model and rapid modes
- [API Routes Reference](./api-routes.md) — MCP server CRUD endpoints, connection list/delete endpoints, Notion OAuth routes
- [Database & Schema](./database.md) — `mcpServers` and `connections` table schemas
- [Settings & Environment](./settings-env.md) — `WEB_SEARCH_MODEL`, `WEB_SEARCH_MAX_RESULTS`, `WEB_SEARCH_MAX_ROUNDS`, `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, cache invalidation (`resetToolProbeCache`)
