Contributing guide for MinervaAIWorkspace — how to set up, develop, test, and submit changes.

Relevant source files: `AGENTS.md`, `README.md`, `package.json`, `.env.example`, `vitest.config.mts`, `vitest.setup.ts`, `tsconfig.json`, `eslint.config.mjs`.

## Welcome

MinervaAIWorkspace is a self-hosted, open-source AI workspace built with Next.js 16 + React 19 and backed by an embedded SQLite database. It combines streaming chat with branching threads, semantic memory, web knowledge ingestion, MCP tool integration, external connections, multi-model workflows, reusable skills, and tone personalization. This guide walks you through getting a local development environment running, understanding the project layout, following our code conventions, and submitting your first contribution. Welcome — we are glad you are here.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| **Bun** | Primary runtime and package manager. Install from [bun.sh](https://bun.sh). |
| **OS** | Windows or Linux. macOS is not supported (Cloudflare Tunnel binary extraction is not implemented). |
| **LLM API key** | Any OpenAI-compatible provider (UmansAI, OpenAI, vLLM, Ollama, etc.). |
| **Docker** (optional) | Only needed for the scraper, embedder, SearXNG search, and Tor services. The standalone exe and local-dev SQLite path need nothing extra. |

> **Note on Next.js 16:** This project uses a version of Next.js with breaking changes from what you may know. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code. Heed deprecation notices.

## Getting Started

```bash
# 1. Clone the repository
git clone https://github.com/johmaru/MinervaAIWorkspace.git
cd MinervaAIWorkspace

# 2. Install dependencies
bun install

# 3. Copy the environment template
cp .env.example .env

# 4. Set your LLM API key (required)
#    Edit .env and fill in LLM_API_KEY
#    Set LLM_MODEL to your preferred default model (optional)

# 5. Generate an AUTH_SECRET and add it to .env
bunx auth secret

# 6. Apply database migrations (creates tables in data/minerva.db)
bunx drizzle-kit migrate

# 7. Run the dev server
bun run dev
#    http://localhost:3000
```

On first launch, the app creates `data/minerva.db` automatically. You will be prompted to create the first admin account (nickname + email + password).

### Optional: Docker services for scraping and search

The scraper, embedder, searxng, and tor services are optional Docker containers you can start when you need scraping/search during local development:

```bash
docker compose up -d scraper embedder searxng tor
```

Point `SCRAPER_URL`, `SEARXNG_URL`, and (for HTTP embeddings) `EMBEDDER_URL` in `.env` to the host-exposed ports when running the app outside Compose.

### Available scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `bun run dev` | Start the Next.js dev server (`predev` hook syncs `.env` and runs migrations) |
| `build` | `bun run build` | Production build |
| `lint` | `bun run lint` | Run ESLint (flat config, Next.js core-web-vitals + TypeScript) |
| `typecheck` | `bun run typecheck` | Run `tsc --noEmit` for type checking |
| `test` | `bun run test` | Single Vitest run |
| `test:watch` | `bun run test:watch` | Vitest watch mode |
| `pack:exe` | `bun run pack:exe` | Build the Windows standalone exe |

## Project Structure

```
MinervaAIWorkspace/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── layout.tsx         # Root layout (fonts, providers)
│   │   ├── page.tsx           # Main chat page → <ChatShell />
│   │   ├── login/             # Login page (first-run admin detection)
│   │   ├── actions/           # Server actions
│   │   └── api/              # API route handlers (all require auth)
│   │       ├── chat/         # SSE streaming chat endpoint
│   │       ├── threads/       # Thread CRUD
│   │       ├── folders/       # Folder CRUD
│   │       ├── memories/      # Memory CRUD
│   │       ├── skills/        # Skills CRUD
│   │       ├── mcp-servers/   # MCP server management
│   │       ├── connections/   # Notion OAuth + tools
│   │       ├── settings/      # Settings GUI → .env
│   │       ├── tunnel/        # Cloudflare Tunnel control
│   │       └── ...
│   ├── components/            # React components (ChatShell, ChatWindow, Sidebar, modals, UI primitives)
│   ├── hooks/                # Custom hooks (useChat, useThreads, useFolders)
│   ├── lib/                  # Core logic (memory, skills, embeddings, MCP, connections, tunnel, search)
│   ├── db/                   # Drizzle ORM schema + SQLite connection
│   ├── auth.ts / auth.config.ts  # Auth.js v5 configuration
│   └── ...
├── embedder/                  # Python sentence-transformers service
├── scraper/                   # FastAPI scraper + SearXNG client
├── launcher/                  # Standalone exe launcher (minerva-launcher.cjs)
├── scripts/                   # Build/pack scripts (pack-exe.ts, sync-env.ts)
├── drizzle/                   # Migration files
├── docs/                      # This documentation
├── AGENTS.md                  # AI agent rules and project conventions
├── PLAN.md                    # Historical phase-by-phase implementation log
└── .env.example               # Environment variable template (source of truth)
```

### Key subsystems

| Subsystem | Docs | Core source |
|-----------|------|-------------|
| Architecture & data flow | [Architecture Overview](./architecture.md) | `src/app/`, `src/lib/` |
| Database & schema | [Database & Schema](./database.md) | `src/db/` |
| Auth & user isolation | [Authentication & User Isolation](./authentication.md) | `src/auth.ts`, `src/lib/auth-guards.ts` |
| API routes | [API Routes Reference](./api-routes.md) | `src/app/api/` |
| Chat & streaming | [Chat & Streaming](./chat-streaming.md) | `src/app/api/chat/route.ts`, `src/hooks/useChat.ts` |
| Tool calling | [Tool Calling](./tool-calling.md) | `src/lib/mcpClient.ts`, `src/lib/connections/` |
| Memory | [Memory System](./memory.md) | `src/lib/memory.ts` |
| Skills | [Skills System](./skills.md) | `src/lib/skills.ts` |
| Personalization | [Personalization](./personalization.md) | `src/lib/personalization.ts` |
| Embeddings | [Embeddings & Vector Search](./embeddings.md) | `src/lib/embed.ts` |
| Frontend components | [Frontend Components](./frontend.md) | `src/components/` |
| Hooks & state | [Hooks & State](./hooks.md) | `src/hooks/` |
| i18n & theming | [i18n & Theming](./i18n-theming.md) | `src/lib/i18n/`, `src/app/globals.css` |
| Settings & env | [Settings & Environment](./settings-env.md) | `src/app/api/settings/`, `.env.example` |
| Deployment | [Deployment](./deployment.md) | `Dockerfile`, `docker-compose.yml`, `scripts/pack-exe.ts` |
| Testing | [Testing Guide](./testing.md) | `vitest.config.mts`, `vitest.setup.ts` |

## Development Workflow

### One implementation = one commit

The core rule: **complete one implementation, then commit and push.** Do not bundle unrelated changes into a single commit. Small, focused, reversible steps are preferred over sweeping rewrites.

### Push to `develop`

After completing each implementation:

```bash
git add -A
git commit -m "<description>"
git push origin develop
```

If asked to amend a past commit, rewrite the previous commit with `git commit --amend` and re-push with `git push --force-with-lease`. If collaborators exist, confirm consent for history rewriting first.

### Commit message conventions

- Messages must be in **English**.
- Briefly describe what changed and the verification result.
- Example: `Add folder memory scope toggle; verified with 3 new tests (all pass)`

### Implementation review loop

For every non-trivial change, follow this loop:

1. **Plan before editing** — identify files likely to change, explain intended component/data/API boundaries, check whether the change fits the existing app structure, and check whether the change requires reading local Next.js docs from `node_modules/next/dist/docs/`. Avoid broad refactors unless explicitly requested.
2. **Implement in small, reversible steps** — prefer focused changes over sweeping rewrites. Preserve existing product behaviour unless the task explicitly asks to change it. Reuse existing components, utilities, naming, spacing, and data flow where possible. Do not introduce one-off patterns unless there is a clear reason.
3. **Review after editing** — examine the diff from these perspectives:
   - **Architecture:** Did this make the overall design simpler or more tangled?
   - **Next.js correctness:** Are App Router, Server/Client Component boundaries, route handlers, redirects, params/searchParams, caching, and async APIs used correctly for this installed Next.js version?
   - **UI/UX consistency:** Does the result match the existing product style, spacing, states, and interaction patterns?
   - **Future extensibility:** Will likely next features be easier or harder after this change?
   - **AGENTS.md rules:** Did this task reveal a repeated pitfall or project rule that should be added here?
4. **Report clearly** — when finishing, include: what changed, how it was verified (test results: pass/fail count, which new test files were added), any risks or follow-up tasks, and whether `AGENTS.md` or README files were updated and why.

If issues are found during review, separate them into:

- **Fix now:** correctness, build, runtime, data loss, accessibility, or obvious UX breakage.
- **Follow up later:** polish, optional refactors, or larger design improvements.

## Code Conventions

### TypeScript

- **Strict mode** is enabled in `tsconfig.json`. All code must pass `bun run typecheck` with zero errors.
- Path alias `@/*` maps to `./src/*` — use it for imports within the project.
- `moduleResolution: "bundler"` is set — use ESM-style imports.

### Styling

- **Tailwind CSS** is the styling system. Use Tailwind utility classes consistently.
- Prefer existing project theme tokens over hardcoded colours.
- Keep spacing, typography, borders, shadows, and radius consistent with the rest of the app.
- Avoid random gradients, excessive shadows, inconsistent spacing, and visually noisy UI.
- Avoid generic SaaS landing-page styling unless working on a marketing page.

### HTML and accessibility

- Use **semantic HTML** elements (`<button>`, `<nav>`, `<main>`, `<article>`, etc.).
- Prefer **accessible primitives/components** when suitable (Radix UI is available).
- Make layouts responsive for mobile, tablet, and desktop.
- Keep loading, empty, error, and disabled states polished.
- Preserve focus-visible ring styling for keyboard navigation.

### Component patterns

- **Reuse existing patterns and components.** Do not introduce one-off patterns unless there is a clear reason.
- Split large JSX into smaller components when readability suffers.
- Respect Server/Client Component boundaries — use `"use client"` only when needed (hooks, event handlers, browser APIs).
- Keep existing product behaviour unless the task explicitly asks to change it.

### Chat UX specifics

When working on chat UI, follow these interaction rules (from `AGENTS.md`):

- Enter sends the message; Shift+Enter inserts a newline.
- The composer should not jump around during typing or streaming.
- Keep sensible scroll behaviour during streaming.
- The latest assistant response should remain easy to follow.
- Copy buttons should not disturb text selection.
- Stop / retry / regenerate actions should only appear when relevant.
- Long conversations should remain navigable.
- Chat should feel fast, calm, and readable.
- Make streaming states clear without being distracting.
- Keep user and assistant messages visually distinct.
- Do not add unnecessary animations to streaming text or chat messages.

## Testing

### Framework

- **Vitest v4** — run `bun run test` for a single run, `bun run test:watch` for watch mode.
- No Jest, no Playwright/E2E layer.
- Config: `vitest.config.mts`, setup: `vitest.setup.ts`.
- Pool: `threads` (the `forks` pool crashes with `sharp` / `@xenova/transformers` native modules).

### Test file placement

- **Co-locate test files next to the source** as `*.test.ts` (logic, route handlers, hooks) or `*.test.tsx` (React components).
- Do **not** create a separate `__tests__/` or `tests/` directory.

### Test environment

- **Default:** `jsdom` (for components and hooks).
- **For `src/lib/*` and `src/app/api/**` tests:** add `// @vitest-environment node` as the **first line** of the file. This is the Vitest 4 mechanism (replaces the removed `environmentMatchGlobs`).

```typescript
// @vitest-environment node
import { describe, it, expect } from "vitest";
// ... your test
```

### Mocking

- Use inline Vitest primitives: `vi.fn`, `vi.mock`, `vi.stubGlobal`, `vi.stubEnv`.
- No central `__mocks__/` or fixtures directory.
- Clean up in `afterEach`:
  - `cleanup()` from `@testing-library/react`
  - `vi.restoreAllMocks()`
  - `vi.unstubAllGlobals()`
  - env-var restore

### Database tests

- **Use the real SQLite via `@/db`** — create rows and tear them down in `afterAll`.
- **Do not mock the database.**
- Auth is mocked via `getSessionUser`.

### What to test

- **New features and bug fixes MUST include tests.**
- Aim at conditional branches, edge values, invariants across fields, and error handling versus silent broken results.
- If a test needs an external API (LLM, embedder) that is unavailable, gate it behind a helper like the existing `itReal()` pattern or skip with a clear reason.
- **Never delete or weaken an assertion to make a test pass.**

### Before claiming work is done

Run `bun run test` and confirm **zero failures**. Also run `bun run typecheck` and `bun run lint` to catch type and style errors.

## Git Workflow

### Commit and push

1. Complete one implementation (focused, reversible).
2. Run `bun run test` — confirm zero failures.
3. Commit with a clear English message describing the change and verification.
4. Push to `develop`:

```bash
git push origin develop
```

### Branch

All development work pushes to the `develop` branch. The `main` branch is for releases.

### CI validation

Every push/PR to `develop` or `main` runs `.github/workflows/ci.yml`: typecheck on ubuntu-latest. Both jobs (typecheck and exe build) must pass before merge.

## Documentation

### When to update READMEs

Update `README.md` (EN) and `README.ja.md` (JA) **in the same commit as the related implementation** when a change affects:

- Documented user-facing behaviour
- Setup instructions
- Configuration or environment variables
- Architecture
- Usage
- Deployment
- Major features

Do **not** update README files for purely internal refactors, small visual polish, typo fixes, or implementation details that users do not need to know.

### Keep both READMEs aligned

The English and Japanese versions should not drift in meaning. Update both together unless explicitly asked to split.

### When to update AGENTS.md

When you discover a repeated pitfall, workflow rule, or implementation convention during development, add it to `AGENTS.md` in the most relevant existing section. Do not add personal preferences, temporary notes, or unrelated facts. After editing, check for duplication, contradiction, or overly specific rules that should be generalized.

## Pull Request Guidelines

When opening a pull request, include:

### Description

- **What changed** — a concise summary of the implementation.
- **Why** — the motivation or problem being solved.

### Verification

- **How verified** — describe how you tested the change.
- **Test results** — what `bun run test` reported (pass/fail count), and which new test files were added.
- **Manual testing** — any manual scenarios you exercised (e.g., "verified streaming chat with branching, rapid mode toggle, and file upload").

### Risks and follow-ups

- **Known risks** — anything that could break (e.g., "changes the embedding migration path; existing users may need to re-embed").
- **Follow-up tasks** — polish, optional refactors, or larger design improvements identified during review.

### Checklist

Before submitting, confirm:

- [ ] `bun run test` passes with zero failures
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] Tests are co-located next to source (`*.test.ts` / `*.test.tsx`)
- [ ] `// @vitest-environment node` added to API/lib test files
- [ ] DB tests use real SQLite (no mocking)
- [ ] No assertions weakened or deleted to make tests pass
- [ ] README.md and README.ja.md updated if user-facing behaviour changed
- [ ] Commit message is in English, describing changes and verification
- [ ] Pushed to `develop`

## Using AI Agents to Contribute

MinervaAIWorkspace is designed for AI-assisted development. Whether you use Claude Code,
Cursor, Copilot, Windsurf, or any other AI agent, the project has adapter files
that point your tool to the right context.

### Quick start for AI-assisted contributors

1. **Clone & setup** — follow the [Getting Started](#getting-started) section above.
2. **Your AI tool reads the rules automatically** — each tool has an adapter file
   that points to `AGENTS.md` (the single source of truth):
   - Claude Code → `CLAUDE.md`
   - Cursor → `.cursor/rules/project.mdc` (modern) or `.cursorrules` (legacy)
   - GitHub Copilot → `.github/copilot-instructions.md`
   - Windsurf → `.windsurfrules`
3. **Read the context files** before making changes:
   - `docs/module-map.md` — know if you're in a safe zone or a high-risk zone
   - `docs/glossary.md` — domain terms specific to this project
   - `docs/patterns/` — good/bad code examples for common tasks
4. **Follow the implementation review loop** described above (plan → implement → review → report).
5. **Tests are mandatory** — see the [Testing](#testing) section and
   `docs/patterns/test.md`.

### What AI agents should NOT do

- Do not edit existing database migration files — generate new ones via `bunx drizzle-kit generate`.
- Do not bypass `getSessionUser()` in any API route.
- Do not mock the database in tests — use real SQLite.
- Do not add "use client" to components that don't need hooks or browser APIs.
- Do not duplicate rules into tool-specific adapter files — edit `AGENTS.md` only.
- Do not weaken or delete test assertions to make tests pass — fix the code instead.

## Where to Get Help

- **[Documentation index](./README.md)** — full table of contributor docs.
- **[AGENTS.md](../AGENTS.md)** — AI agent rules, project conventions, and known pitfalls.
- **[Main README (EN)](../README.md)** — user-facing setup, features, and configuration.
- **[Main README (JA)](../README.ja.md)** — Japanese version.
- **[PLAN.md](../PLAN.md)** — historical phase-by-phase implementation log.
- **[Testing Guide](./testing.md)** — detailed Vitest v4 setup and conventions.

### Known pitfalls

Before debugging SSE streaming, Docker build, transformers.js, SQLite, or Next.js 16 issues, read the MinervaAIWorkspace Debug Guide referenced in `AGENTS.md`. A key pitfall: `generateMemories` in `src/app/api/chat/route.ts` must run via `after()` (not bare fire-and-forget, not blocking `await`), and `after()` must be called in the POST handler body (request scope), not inside the `ReadableStream` `start()` callback.

## See also

- [Architecture Overview](./architecture.md)
- [Database & Schema](./database.md)
- [Authentication & User Isolation](./authentication.md)
- [API Routes Reference](./api-routes.md)
- [Chat & Streaming](./chat-streaming.md)
- [Tool Calling](./tool-calling.md)
- [Memory System](./memory.md)
- [Skills System](./skills.md)
- [Personalization](./personalization.md)
- [Embeddings & Vector Search](./embeddings.md)
- [Frontend Components](./frontend.md)
- [Hooks & State](./hooks.md)
- [i18n & Theming](./i18n-theming.md)
- [Settings & Environment](./settings-env.md)
- [Deployment](./deployment.md)
- [Testing Guide](./testing.md)
