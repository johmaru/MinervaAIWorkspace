<!-- BEGIN:work-completion-skill -->
# Work Completion Checklist — MANDATORY

**The `work-completion-checklist` rule (`alwaysApply: true`) is auto-injected
into every system prompt.** It covers: post-implementation review, test
verification, git commit/push, README sync, the no-uncommitted-files rule
(every file must be committed or added to `.gitignore`), and the end-of-task
checklist. This is the highest-priority end-of-work gate — skipping it is
not optional.

For detailed guidance and examples, read `skill://work-completion-checklist`.
<!-- END:work-completion-skill -->

<!-- BEGIN:ai-tool-adapters -->
# AI Tool Adapters

This file (`AGENTS.md`) is the **single source of truth** for all project rules.
Tool-specific instruction files are thin pointers that redirect here — they
contain no rules of their own. When updating rules, edit `AGENTS.md` only.

| Tool | Adapter file | Notes |
|------|-------------|-------|
| Claude Code | `CLAUDE.md` | Pointer to AGENTS.md + context file index |
| Cursor (modern) | `.cursor/rules/project.mdc` | `alwaysApply: true`, auto-injected on every file |
| Cursor (legacy) | `.cursorrules` | Fallback for older Cursor versions |
| GitHub Copilot | `.github/copilot-instructions.md` | Pointer to AGENTS.md |
| Windsurf | `.windsurfrules` | Pointer to AGENTS.md |
| OMP / Codex | `AGENTS.md` (this file) | Read natively — no adapter needed |

**Do not duplicate rules across adapter files.** Each adapter is a static
pointer. If a new rule is needed, add it here. If a new AI tool needs an
adapter, create a tiny pointer file — do not copy rules into it.

## Context Files for AI Agents

Beyond this file, AI agents should read these for deeper context:

| File | Purpose |
|------|---------|
| `docs/module-map.md` | Module boundaries, safety zones (🟢 safe / 🟡 caution / 🔴 high-risk) |
| `docs/glossary.md` | Domain terms (thread, branch, leaf, memory, skill, etc.) |
| `docs/patterns/api-route.md` | API route handler pattern with good/bad examples |
| `docs/patterns/component.md` | React component pattern with good/bad examples |
| `docs/patterns/test.md` | Test writing pattern with good/bad examples |
| `docs/patterns/db-migration.md` | Database migration workflow and pitfalls |
<!-- END:ai-tool-adapters -->
<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:minerva-debug-skill -->
# MinervaAIWorkspace Debug Guide

Before debugging SSE streaming, Docker build, transformers.js, SQLite, or
Next.js 16 issues in this project, read `skill://minerva-debug`
for known pitfalls and solutions discovered during development.

Key pitfall: `generateMemories` in `src/app/api/chat/route.ts` must run via
`after()` (not bare fire-and-forget, not blocking `await`), and `after()`
must be called in the POST handler body (request scope), NOT inside the
`ReadableStream` `start()` callback. A blocking `await` before
`controller.close()` keeps the client's `isStreaming` high and freezes the
UI after the answer. A bare `void` after `close()` is cancelled by the
Next.js runtime. Calling `after()` inside `start()` silently fails because
the request context (waitUntil) is already gone — the callback never runs.
Use a Promise bridge (`streamDone`) so the `after()` callback in the POST
body can await stream completion and read the final `assistantContent`.
<!-- END:minerva-debug-skill -->

<!-- BEGIN:frontend-quality-rules -->
# Frontend Quality Rules

This project is an AI chat platform built with React / Next.js App Router.

Before editing Next.js code, follow the Next.js agent rules above and check the relevant local documentation in `node_modules/next/dist/docs/` when needed.

When editing frontend UI:
- Improve clarity and usability before decoration.
- Use semantic HTML.
- Use Tailwind CSS consistently.
- Prefer accessible primitives/components when suitable.
- Keep spacing, typography, borders, shadows, and radius consistent.
- Make layouts responsive for mobile, tablet, and desktop.
- Avoid random gradients, excessive shadows, inconsistent spacing, and visually noisy UI.
- Avoid generic SaaS landing-page styling unless working on a marketing page.
- Split large JSX into smaller components when readability suffers.
- Keep loading, empty, error, and disabled states polished.
- Preserve existing product behaviour unless the task explicitly asks to change it.
- After editing, check TypeScript, lint, layout issues, and console errors where possible.

AI chat product UX:
- Chat should feel fast, calm, and readable.
- Prioritise message readability, input ergonomics, and conversation navigation.
- Make streaming states clear without being distracting.
- Keep user messages and assistant messages visually distinct.
- Make code blocks readable, copyable, and horizontally scrollable when needed.
- Handle long messages, markdown, lists, tables, and inline code gracefully.
- Ensure the composer works well with multiline input, attachments if present, and keyboard shortcuts.
- Important actions such as send, stop, retry, edit, copy, and regenerate should be easy to find.
- Empty states should guide the user without looking like a generic template.
- Error states should explain what happened and offer a clear next action.
- Settings, model selection, and conversation controls should be discoverable but not visually loud.
- Do not add unnecessary animations to streaming text or chat messages.

Design direction:
- Clean, focused, modern chat interface.
- Similar quality bar to ChatGPT / Claude / Perplexity style products, but do not blindly clone them.
- Prioritise legibility, low visual noise, and smooth daily use.
- Prefer restrained polish over decorative UI.
<!-- END:frontend-quality-rules -->

Implementation Review Loop

For every non-trivial feature, bug fix, or UI change, follow this loop:

Plan before editing
Briefly identify the files likely to change.
Explain the intended component/data/API boundaries.
Check whether the change fits the existing app structure.
Check whether the change requires reading local Next.js docs from node_modules/next/dist/docs/.
Avoid broad refactors unless explicitly requested.
Implement in small, reversible steps
Prefer focused changes over sweeping rewrites.
Preserve existing product behaviour unless the task explicitly asks to change it.
Reuse existing components, utilities, naming, spacing, and data flow where possible.
Do not introduce one-off patterns unless there is a clear reason.
Review after editing and Report clearly — see `skill://work-completion-checklist` sections 1 (Review after editing) and 2 (Report clearly).

## Chat Interaction Details

- Enter should send the message.
- Shift+Enter should insert a newline.
- The composer should not jump around during typing or streaming.
- The page should keep sensible scroll behaviour during streaming.
- The latest assistant response should remain easy to follow.
- Copy buttons should not disturb text selection.
- Stop / retry / regenerate actions should only appear when relevant.
- Long conversations should remain navigable.

## Git Workflow

See `skill://work-completion-checklist` section 5 (Git Workflow).

## Testing

- **Framework:** Vitest v4 (`bun run test` for single run, `bun run test:watch` for watch mode).
  No Jest, no Playwright/E2E layer. Config: `vitest.config.mts`, setup: `vitest.setup.ts`.

- **New features and bug fixes MUST include tests.** Co-locate test files next to
  the source as `*.test.ts` (logic, route handlers, hooks) or `*.test.tsx` (React
  components). Do not create a separate `__tests__/` or `tests/` directory.

- **Environment:** default is jsdom (components, hooks). For `src/lib/*` and
  `src/app/api/**` tests, add `// @vitest-environment node` as the first line.
  This is the Vitest 4 mechanism (replaces the removed `environmentMatchGlobs`).

- **Mocking:** use inline Vitest primitives (`vi.fn`, `vi.mock`, `vi.stubGlobal`,
  `vi.stubEnv`). No central `__mocks__/` or fixtures directory. Clean up in
  `afterEach` (`cleanup()` from `@testing-library/react`, `vi.restoreAllMocks()`,
  `vi.unstubAllGlobals()`, env-var restore).

- **DB tests:** use the real SQLite via `@/db`; create rows and tear them down in
  `afterAll`. Do not mock the database.

- **Before claiming work is done:** see `skill://work-completion-checklist` section 3 (Testing — Before claiming work is done).


## GitHub Repository

When the user mentions "GitHub", "the repo", "the repository", "issues", "PRs", or similar without specifying which one, assume they mean **this project's repository**: https://github.com/johmaru/UmansChat-Unofficial (private). If it is still ambiguous which repository they mean, ask for confirmation before proceeding.

## Project Rule Memory
When the user says "remember this for next time," "make sure to remember this," or similar, decide whether the content is a durable project rule, workflow rule, known pitfall, or implementation convention.
Add it to AGENTS.md only when it should affect future work in this repository.
Do not add personal preferences, temporary notes, random reminders, or unrelated facts to AGENTS.md.
When adding a rule, place it in the most relevant existing section when possible.
After editing, check for duplication, contradiction, or overly specific rules that should be generalized.
If the instruction is ambiguous, ask whether it should be stored as a project rule before editing AGENTS.md.

## Skill Creation After Implementation
See `skill://work-completion-checklist` section 7 (Skill Creation After Implementation).

### Developer Skills vs Runtime Skills
- **Developer Skills** (`.agents/skills/`): Markdown files read by Codex/OMP/dev agents during development. Contain debugging pitfalls, project conventions, and workflow recipes. Updated manually by the developer after hitting a problem.
- **Runtime Skills** (DB `skills` table): User-facing reusable prompts stored in SQLite, searched via embedding and injected into chat system context. Managed via the Skill Manager UI (sidebar 🛠️ button) and auto-extracted as draft candidates from conversations.
- These are separate systems with different purposes; do not mix them. The `.agents/skills/` directory is never read by the running app, and the `skills` DB table is never read by dev agents.

### Public product vs personal domain logic
MinervaAIWorkspace is a **public** app. Core agent tools (`STREAM_TOOLS`) and `src/lib` product APIs must stay **schema-agnostic** (JSONL fields, workspace files, sandbox, generic KB). Do **not** add tools or libraries that encode one developer's private data format (game dumps, personal pipelines). Domain transforms belong in the user's workspace (scripts → JSONL → `kb_from_jsonl`), runtime skills, or out-of-tree plugins — not in the shared core.


## Release & Distribution

**Top priority: Always release both Docker and exe distributions.** Releasing only
one is incomplete. Regardless of whether it's a new feature or bug fix, always
generate and publish both artifacts on release.

Two distribution formats, both produced by GitHub Actions on every release:

- **Docker images** (GHCR): `app`, `scraper`, `embedder` — 3 images, tagged `:<version>` + `:latest`.
- **Windows standalone exe**: `MinervaAIWorkspace-<version>-windows-x64.zip` — attached to the GitHub Release.

### Release trigger

Releases are manual only (`workflow_dispatch`). Run only when the user instructs to "release."
Do not auto-release on tag push.

```
Actions tab → Release → Run workflow → enter version (e.g., 1.2.3)
```

The `version` input is required. It cannot run without it (prevents accidental overwrite of `:latest`).

### Pipeline (`.github/workflows/release.yml`)

1. `prepare` — computes a single shared `version` + `tag` (consumed by all later jobs).
   Manual dispatch → `v${inputs.version}` (version input is required).
2. `docker` (ubuntu-latest) — builds & pushes the 3 images to GHCR.
3. `exe` (windows-latest) — runs `bun run pack:exe` natively, zips `dist/Minerva/`,
   uploads as a workflow artifact. **No cross-compilation** — the exe is built on
   Windows to match what end-users download.
4. `release` (`needs: [prepare, docker, exe]`) — creates the GitHub Release and
   attaches the zip. Runs only after both artifacts succeed, so a Docker failure
   cannot publish an exe-only release.

### GHCR image names (all lowercase — GHCR rejects uppercase)

```
ghcr.io/johmaru/minerva-ai-workspace-app:<version>
ghcr.io/johmaru/minerva-ai-workspace-scraper:<version>
ghcr.io/johmaru/minerva-ai-workspace-embedder:<version>
```

### Local build commands

```bash
bun run pack:exe    # build .next/standalone → assemble dist/Minerva/ → compile minerva.exe
docker compose up -d --build   # local dev: build all 3 images from source
docker compose pull            # release: pull published GHCR images
```

### CI validation (`.github/workflows/ci.yml`)

On every push/PR to `develop`/`main`: builds all 3 Docker images (no push) and runs
`bun run pack:exe` on windows-latest. Both jobs must be green before merge.

### Parity rule

The exe distribution must contain the same application code as the Docker image.
Both produce the same Next.js standalone output with `DATABASE_URL=":memory:"`
(Dockerfile uses `npx next build`; pack-exe.ts uses `bun run build`).
Do not add exe-only or Docker-only code paths unless a fundamental platform constraint
forces it — and if so, document it in `skill://minerva-debug` and here.

## Cloudflare Tunnel GUI

Configure, start, and stop Cloudflare Tunnel from the GUI (SettingsModal).
Token changes and AUTH_URL switching take effect immediately without restarting the app.

### How It Works

- **API**: `/api/tunnel` (GET: status, POST: start, DELETE: stop)
  - Token is never returned in plaintext in GET responses (only `hasToken`)
  - AUTH_URL is saved to .env dynamically and mirrored to MINERVA_CONFIGURED_AUTH_URL; redirects follow the request Host header (dual local + Cloudflare access, no localhost trap, no restart needed)
  - On token change, `startTunnel(token, { force: true })` stops and restarts (avoids using stale tokens)
- **Process management**: `src/lib/tunnel.ts`
  - Docker environment: `docker compose --profile tunnel up -d --force-recreate cloudflared`
  - exe environment: downloads cloudflared binary to `data/cloudflared/` and spawns a child process
  - Security: fixed version + SHA256 verification + HTTPS only + no auto-update
  - Supported platforms: Windows x64 (standalone exe), Linux x64 (Node/Bun runtime)

### Notes

- The Tunnel URL cannot be auto-discovered. The user must enter the public hostname (`https://your-tunnel.example.com`)
- Google OAuth redirect URI must match the AUTH_URL
- The SHA256 hash of the cloudflared binary is hardcoded with locally verified values (`CLOUDFLARED_HASHES`). Must be updated on version upgrades

## Documentation Sync

See `skill://work-completion-checklist` section 6 (Documentation Sync). For the detailed README update procedure (what to check, where to look, dual-file parity rule), see `skill://readme-update-guide`.

# Homepage Design Direction

Design the homepage to feel cool, calm, technical, and mature.

The visual style should be:
- modern but not flashy
- elegant but not luxury-brand-like
- technical but not cyberpunk
- calm, readable, and trustworthy
- suitable for a low-level / embedded / FPGA-oriented engineer portfolio

Avoid:
- excessive gradients
- loud neon colours
- overused startup landing page sections
- huge empty hero sections with vague slogans
- gimmicky animations
- random decorative blobs
- overly cute UI
- corporate template feeling

Prefer:
- dark or neutral background
- subtle borders
- restrained accent colour
- clean typography
- strong spacing
- card-based sections
- code/terminal-inspired details used lightly
- clear hierarchy
- responsive layout
- small tasteful motion only when useful

Use Tailwind CSS utilities.
Prefer existing project theme tokens over hardcoded colours.
Keep the design consistent across desktop and mobile.