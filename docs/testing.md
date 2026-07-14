Testing guide for contributors — framework, configuration, conventions, and patterns for writing tests in UmansChat.

## Relevant source files

- `vitest.config.mts` — Vitest configuration (plugins, environment, pool, aliases)
- `vitest.setup.ts` — global setup (jest-dom, env loading, DB migration, test user)
- `package.json` — `test` / `test:watch` scripts
- `AGENTS.md` — project rules for testing (no weakened assertions, `itReal()` gating)
- `src/**/*.test.ts` / `src/**/*.test.tsx` — co-located test files

---

## Framework & Commands

Tests run on **Vitest v4** with the `@vitejs/plugin-react` plugin and `jsdom` environment.

| Command | Description |
|---------|-------------|
| `bun run test` | Single run (`vitest run`) — exits after completion. Use for CI and one-shot verification. |
| `bun run test:watch` | Watch mode (`vitest`) — re-runs on file change during development. |
| `bun run test -- <pattern>` | Filter to a path or pattern, e.g. `bun run test -- src/lib/llm`. |

> **Note:** Watch mode is enabled with the `--watch` flag (`bun run test -- --watch`), since `test` maps to `vitest run` (non-watch) and `test:watch` maps to `vitest` (watch).

The global test timeout is **30 seconds** (`testTimeout: 30_000` in config) to accommodate tests that call the real LLM API. Individual tests needing more time pass an explicit timeout, e.g. `itReal("...", async () => { ... }, 120_000)`.

---

## Vitest Configuration

The full configuration lives in `vitest.config.mts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      "next/server": "next/server.js",
    },
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30_000,
    pool: "threads",
    server: {
      deps: {
        inline: ["next-auth"],
      },
    },
  },
});
```

### Plugins

- **`@vitejs/plugin-react`** — enables JSX/TSX transform for component tests and Fast Refresh-aware transforms.

### Resolve aliases

- **`tsconfigPaths: true`** — Vite resolves `tsconfig.json` paths natively (no `vite-tsconfig-paths` plugin needed). The `@/*` → `./src/*` alias works in tests exactly as in the app.
- **`"next/server": "next/server.js"`** — Next 16 requires resolving `next/server` as `next/server.js`, but `next-auth` 5.0.0-beta imports the bare `next/server` and fails ESM resolution. This alias normalizes the import to the `.js` form for tests only.

### Environment

- **`environment: "jsdom"`** — the default test environment. Required for React component tests (DOM APIs, `@testing-library/react`).

### Why `pool: "threads"`

The worker pool is **`threads`** (not the Vitest default `forks`). Native modules — `sharp` and `@xenova/transformers` — crash workers in the `forks` pool. The `threads` pool avoids this.

### `server.deps.inline`

```ts
server: { deps: { inline: ["next-auth"] } }
```

Aliases only apply to modules that Vite transforms. `next-auth` is a pre-bundled dependency, so Vite would skip transforming it and the `next/server` alias wouldn't apply. Inlining `next-auth` as an SSR transform target forces Vite to process it, making the alias take effect.

### Excludes

`**/dist/**` and `**/.next/**` are excluded so test files copied into build artifacts (by `pack:exe` / standalone output) aren't collected as duplicate test runs.

---

## Environment Strategy

There are **two** test environments, selected per-file:

| Environment | When to use | How to select |
|-------------|-------------|---------------|
| `jsdom` (default) | React component tests, hooks tests using `@testing-library/react` | Default — no annotation needed |
| `node` | API Route Handler tests, `src/lib/*` unit tests, `src/db/*` tests | `// @vitest-environment node` comment at the **top** of the file |

> Vitest 4 removed `environmentMatchGlobs`, so environment selection is now done with the per-file `// @vitest-environment node` pragma. The pragma **must be the first line** of the file.

Example (from `src/lib/llm.test.ts`):

```ts
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createLLM, defaultModel, embedModel } from "@/lib/llm";

describe("llm client", () => {
  // ...
});
```

The `node` environment is preferred for any test that does not touch the DOM — it is faster and avoids loading jsdom. When in doubt: if the test imports `@testing-library/react` or renders JSX, keep `jsdom`; otherwise use `node`.

---

## Setup File: `vitest.setup.ts`

Loaded once per worker via `setupFiles: ["./vitest.setup.ts"]`. It performs five jobs, in order:

### 1. jest-dom matchers

```ts
import "@testing-library/jest-dom/vitest";
```

Adds DOM assertion matchers (`toBeInTheDocument`, `toHaveTextContent`, etc.) to Vitest's `expect`.

### 2. `scrollTo` polyfill

```ts
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function () {};
}
```

jsdom does not implement `HTMLElement.prototype.scrollTo`. Auto-scroll-follow logic in `ChatWindow` throws `TypeError` in tests without this polyfill.

### 3. `DATABASE_URL` override (temp file)

```ts
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("/app/data/")) {
  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  process.env.DATABASE_URL = join(tmpdir(), `umanschat-test-${process.pid}-${workerId}.db`);
  try { unlinkSync(process.env.DATABASE_URL); } catch { /* does not exist on first run */ }
}
```

- The Docker-internal path (`/app/data/`) from `.env` is replaced with a **temp file** in the OS temp dir for local/CI runs.
- `:memory:` is **not** used because `openDatabase`'s `fileMustExist` probe throws on a memory DB, causing `recoverDatabase` to emit a corruption warning.
- `VITEST_WORKER_ID` gives each worker thread a unique file, preventing migrate races ("table already exists") during parallel execution.
- Any leftover file from a previous run is removed before creating a new one.

### 4. `.env` loading

```ts
const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
// ...minimal parser...
if (process.env[key] === undefined) {
  process.env[key] = val;
}
```

Vitest does **not** auto-load `.env` like Next.js does. Route Handler tests that call the real API (`api.code.umans.ai`) require `LLM_API_KEY` / `LLM_MODEL`, so the project-root `.env` is injected into `process.env` with a minimal parser. Values already set in env are **not** overwritten, so CI can override them.

### 5. Docker host override

```ts
if (process.env.EMBEDDER_URL?.includes("embedder:")) {
  process.env.EMBEDDER_URL = "http://localhost:8001";
}
if (process.env.SEARXNG_URL?.includes("searxng:")) {
  process.env.SEARXNG_URL = "http://localhost:8081";
}
```

When running tests from the host, Docker-internal service names (`embedder:`, `searxng:`) are overridden with host-reachable ports. Inside Docker (production) these are overridden by `docker-compose.yml`, so this has no effect there.

### 6. DB migration + test user

```ts
const globalForTestSetup = globalThis as unknown as { __umanschatTestDbReady?: boolean };
if (!globalForTestSetup.__umanschatTestDbReady) {
  const { db } = await import("@/db");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });

  const { users } = await import("@/db/schema");
  await db.insert(users).values({ id: "test-user-id", nickname: "tester", email: "t@example.com" }).onConflictDoNothing();
  globalForTestSetup.__umanschatTestDbReady = true;
}
```

- Static imports are hoisted, so `@/db` would be evaluated **before** `DATABASE_URL` is set. A **dynamic import** loads it after configuration.
- `db` is cached on `globalThis`, so all test files in a worker share the same migrated DB.
- Migration and test-user creation run **once per process** (the `__umanschatTestDbReady` guard).
- The test user `test-user-id` is pre-created to satisfy FK constraints for tests that mock auth guards. It is **shared across all tests** and never deleted (the temp DB is disposable).

---

## Mocking Conventions

UmansChat uses **inline Vitest primitives** — there is **no central mocks directory**. All mocking is declared at the top of the test file that needs it.

### Available primitives

| Primitive | Purpose |
|-----------|---------|
| `vi.fn()` | Create a mock function with controllable return values. |
| `vi.mock(path, factory)` | Replace a module with a factory. **Hoisted** — runs before imports. |
| `vi.hoisted(() => ...)` | Define variables safe to reference inside hoisted `vi.mock` factories. |
| `vi.stubGlobal(key, value)` | Replace a global (`fetch`, `window`, etc.). |
| `vi.stubEnv(key, value)` | Replace an env var (auto-restored after test). |
| `vi.mocked(fn)` | Type-narrow a mocked function to access `.mockReturnValue` / `.mockReset`. |

### Auth mocking: `getSessionUser`

API Route Handlers all require auth via `getSessionUser()` from `@/lib/auth-guards`. In tests this is mocked to return the pre-created test user:

```ts
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
```

This pattern appears at the top of every API route test (e.g. `src/app/api/threads/route.test.ts`, `src/app/api/chat/route.test.ts`). The returned `id` matches the test user created in `vitest.setup.ts`, so DB writes satisfy FK constraints.

### Hoisted mocks with `vi.hoisted`

`vi.mock` factories are hoisted above imports, so any variable referenced inside must be created with `vi.hoisted`:

```ts
const { capturedMessages, fakeLlm, useFakeLlm } = vi.hoisted(() => {
  const captured: Record<string, unknown>[][] = [];
  const fake = { chat: { completions: { create: vi.fn(async (params) => { ... }) } } };
  let useFake = false;
  return { capturedMessages: captured, fakeLlm: fake, useFakeLlm: { get: () => useFake, set: (v) => useFake = v } };
});

vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return {
    ...actual,
    createLLM: vi.fn(() => (useFakeLlm.get() ? fakeLlm : actual.createLLM())),
  };
});
```

This pattern (from `src/app/api/chat/route.test.ts`) lets a single test file toggle between a fake LLM (unit tests) and the real LLM (`itReal` tests).

### Partial mocks with `importOriginal`

When mocking a module, preserve un-mocked exports by spreading the original:

```ts
vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return { ...actual, createLLM: vi.fn(() => fakeLlm) };
});
```

### No central mocks directory

There is no `__mocks__/` folder. Each test file declares exactly the mocks it needs. This keeps mock scope local — a mock leak from one file can never silently affect another.

### Cleanup in `afterEach`

Mock state is reset between tests to prevent leaks. The standard pattern:

```ts
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
```

For mocked modules with call history, reset explicitly:

```ts
beforeEach(() => {
  vi.mocked(searchWeb).mockReset();
  vi.mocked(decideSearch).mockReset();
});
```

When mutating `process.env`, snapshot the originals and restore them in `afterEach`:

```ts
const ORIGINAL = { LLM_API_KEY: process.env.LLM_API_KEY, /* ... */ };

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
```

---

## Database Tests

**Do not mock the database.** DB-dependent tests use the **real SQLite** instance via `@/db`, migrated in `vitest.setup.ts`.

### Pattern: create rows + teardown in `afterAll`

Each test creates its own rows and tracks their IDs for bulk cleanup at the end:

```ts
import { db } from "@/db";
import { threads } from "@/db/schema";
import { eq } from "drizzle-orm";

const createdIds: string[] = [];

afterAll(async () => {
  for (const id of createdIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
});
```

IDs are pushed into `createdIds` as each test creates a row. Bulk deletion in `afterAll` avoids per-test cleanup overhead and prevents collisions in parallel execution.

### Why not mock the DB?

The shared migrated temp DB is fast and disposable. Mocking the DB would hide real SQL/Drizzle behavior, type mismatches, and schema-constraint errors. Route Handler tests exercise the full request → DB → response path with real queries.

### Mocking DB-adjacent services

Tests that touch DB write paths but need deterministic external behavior mock only the **adjacent** service (embedder, scraper, LLM) — never the DB itself. For example, `src/lib/memoryStore.test.ts` mocks `embedText` to return a deterministic vector while writing real rows to the `memories` table:

```ts
vi.mock("@/lib/embed", () => ({
  embedText: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(1024).fill(0);
    for (const ch of text) vec[ch.charCodeAt(0) % 1024] = 1;
    return vec;
  }),
  hashContent: vi.fn().mockImplementation((text: string) =>
    createHash("sha256").update(text).digest("hex")),
}));
```

---

## Test File Co-location

Tests are **co-located** next to the source they cover — there is no separate `test/` or `__tests__/` directory.

- `*.test.ts` — for `.ts` source (libs, API routes, DB)
- `*.test.tsx` — for `.tsx` source (components, hooks)

Examples:

```
src/lib/llm.ts            → src/lib/llm.test.ts
src/components/ChatWindow.tsx → src/components/ChatWindow.test.tsx
src/hooks/useThreads.ts   → src/hooks/useThreads.test.ts
src/app/api/threads/route.ts → src/app/api/threads/route.test.ts
```

---

## Test Files by Category

### API Route Handlers (`src/app/api/`)

All use `// @vitest-environment node`, mock `@/lib/auth-guards`, and hit the real DB.

| File | Covers |
|------|--------|
| `src/app/api/chat/route.test.ts` | SSE streaming, search sources, memory injection, rapid mode, title auto-gen |
| `src/app/api/chat/instruction.test.ts` | Instruction resolution |
| `src/app/api/threads/route.test.ts` | Thread list/create/update |
| `src/app/api/threads/[id]/route.test.ts` | Thread get/delete |
| `src/app/api/folders/route.test.ts` | Folder CRUD |
| `src/app/api/memories/route.test.ts` | Memory list/create |
| `src/app/api/memories/[id]/route.test.ts` | Memory update/soft-delete |
| `src/app/api/skills/route.test.ts` | Skill list/create |
| `src/app/api/skills/[id]/route.test.ts` | Skill update/delete |
| `src/app/api/skill-candidates/route.test.ts` | Candidate status flow |
| `src/app/api/search/route.test.ts` | Semantic search |
| `src/app/api/scrape/route.test.ts` | URL scrape |
| `src/app/api/settings/route.test.ts` | Settings get/set, embedding migration |
| `src/app/api/models/route.test.ts` | Available models |
| `src/app/api/tunnel/route.test.ts` | Cloudflare tunnel |

### Libraries (`src/lib/`)

All use `// @vitest-environment node`.

| File | Covers |
|------|--------|
| `src/lib/llm.test.ts` | `createLLM`, `defaultModel`, `embedModel`, env validation |
| `src/lib/llm.reasoning.test.ts` | Reasoning model path |
| `src/lib/llm.umans.test.ts` | Umans-specific LLM client |
| `src/lib/memory.test.ts` | Memory extraction |
| `src/lib/memoryStore.test.ts` | `findRelevantMemories`, cosine search, recency |
| `src/lib/embed.test.ts` | Embedding client, dimension handling |
| `src/lib/vectorSearch.test.ts` | Vector similarity search |
| `src/lib/searchDecision.test.ts` | Search-level routing |
| `src/lib/scraper.test.ts` | Scraper client |
| `src/lib/pageStore.test.ts` | Page upsert/store |
| `src/lib/skillGenerator.test.ts` | Skill generation |
| `src/lib/skillCandidate.test.ts` | Candidate pipeline |
| `src/lib/personalization.test.ts` | Style/trait injection |
| `src/lib/toolCallSanitizer.test.ts` | Tool-call argument sanitization |
| `src/lib/contextCompaction.test.ts` | Context window compaction |
| `src/lib/wikipedia.test.ts` | Wikipedia search |
| `src/lib/envUtils.test.ts` | Env parsing utilities |
| `src/lib/i18n/i18n.test.ts` | i18n dictionaries / interpolation |

### Database (`src/db/`)

| File | Covers |
|------|--------|
| `src/db/index.test.ts` | `openDatabase`: journal mode, corruption self-heal |

### Hooks (`src/hooks/`)

Use `jsdom` (default), `@testing-library/react`'s `renderHook`, and a mocked `fetch`.

| File | Covers |
|------|--------|
| `src/hooks/useChat.test.ts` | SSE handling, branching, optimistic IDs |
| `src/hooks/useThreads.test.ts` | Thread list CRUD via fetch |
| `src/hooks/useFolders.test.ts` | Folder list CRUD via fetch |

### Components (`src/components/`)

Use `jsdom` (default) and `@testing-library/react`'s `render`/`screen`/`fireEvent`.

| File | Covers |
|------|--------|
| `src/components/ChatShell.test.tsx` | Shell rendering, modals |
| `src/components/ChatWindow.test.tsx` | Message list, input, branch nav |
| `src/components/ThreadSettings.test.tsx` | Thread config form |
| `src/components/SearchBar.test.tsx` | Search input |
| `src/components/UrlInput.test.tsx` | URL input |
| `src/components/MemoryViewerModal.test.tsx` | Memory viewer/editor |
| `src/components/Markdown.test.tsx` | Markdown rendering, code blocks |
| `src/components/ContextMenu.test.tsx` | Right-click menu |
| `src/components/LoginForm.test.tsx` | Login form |
| `src/components/ThemeToggle.test.tsx` | Theme toggle button |
| `src/components/AttachmentBar.test.tsx` | Attachment bar |

### Scripts (`scripts/`)

| File | Covers |
|------|--------|
| `scripts/sync-env.test.ts` | `.env` sync logic |

---

## How to Write a New Test

### 1. Pick the environment

- Rendering JSX / using `@testing-library/react` → `jsdom` (default, no annotation).
- Anything else (API routes, libs, DB, scripts) → add `// @vitest-environment node` as the **first line**.

### 2. Co-locate the file

Create `<source>.test.ts` (or `.test.tsx`) next to the source file.

### 3. Mock auth (API routes only)

```ts
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
```

### 4. Import and test

```ts
// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn().mockResolvedValue({ id: "test-user-id" }),
}));
import { db } from "@/db";
import { threads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { GET, POST } from "@/app/api/threads/route";

const createdIds: string[] = [];
afterAll(async () => {
  for (const id of createdIds) await db.delete(threads).where(eq(threads.id, id));
});

describe("GET /api/threads", () => {
  it("returns 200 + array", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
```

### Component test example

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
import { MyComponent } from "@/components/MyComponent";

afterEach(() => cleanup());

describe("MyComponent", () => {
  it("renders the title", () => {
    render(<MyComponent title="hello" />);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});
```

### Hook test example

```ts
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = vi.fn(); });
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("useMyHook", () => {
  it("loads data on mount", async () => {
    (globalThis.fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const { result } = renderHook(() => useMyHook());
    await waitFor(() => expect(result.current.data).toEqual({ ok: true }));
  });
});
```

### Conventions checklist

- ✅ Restore env vars in `afterEach` if you mutate `process.env`.
- ✅ Reset mocked module call history in `beforeEach` / `afterEach`.
- ✅ Track created DB rows and delete them in `afterAll`.
- ✅ Never mock `@/db` — use the real migrated temp DB.
- ✅ Never delete or weaken an assertion to make a test pass (per `AGENTS.md`).

---

## The `itReal()` Pattern

Some tests need a **real external API** (LLM, embedder) that may be unavailable in a given environment (no `.env` credentials, CI without network). These are gated behind an `itReal` helper so the suite still passes when the API is absent — but the test **runs in full** when credentials exist.

### Definition

At the top of the test file, after mocks and env loading:

```ts
const hasCreds = Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
const itReal = hasCreds ? it : it.skip;
```

When credentials are present, `itReal` is just `it` — the test runs. When absent, it's `it.skip` — the test is reported as skipped, not failed.

### Usage

```ts
describe("POST /api/chat — real API streaming + DB persistence", () => {
  itReal("returns start/delta/done via SSE and saves user/assistant to DB", async () => {
    const id = await createThread();
    const res = await POST(chatReq(id, "「OK」とだけ2文字で返して。"));
    // ...assert SSE event order + DB rows...
  }, 120_000); // explicit timeout for real API latency
});
```

### Variant: feature-gated (`itCli`)

When a test depends on an external **tool** rather than credentials, the same pattern gates on tool availability:

```ts
// src/db/index.test.ts
const hasSqlite3Cli = (() => {
  try { execSync("sqlite3 --version", { stdio: "ignore" }); return true; }
  catch { return false; }
})();
const itCli = hasSqlite3Cli ? it : it.skip;
```

### Rules (from `AGENTS.md`)

- If a test needs an external API (LLM, embedder) that is unavailable, gate it behind a helper like `itReal()` **or skip with a clear reason**.
- **Never delete or weaken an assertion to make a test pass.** If a real-API test fails due to a genuine regression, it must fail — do not convert it to `itReal` to hide the failure.
- `itReal` tests that call the real LLM use the `.env` values loaded by `vitest.setup.ts`. Run them locally with valid `LLM_API_KEY` / `LLM_MODEL` set.

---

## See also

- [Hooks & State](./hooks.md) — `useChat`, `useThreads`, `useFolders` (the hooks these tests cover)
- [API Routes Reference](./api-routes.md) — endpoint reference for the route handlers under test
- [Database & Schema](./database.md) — schema and migration details for DB tests
- [Architecture Overview](./architecture.md) — how test subsystems fit the whole
