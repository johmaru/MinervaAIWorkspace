# Deployment

How UmansChat is built, packaged, released, and run — covering Docker Compose, the standalone Windows exe, CI/CD pipelines, Cloudflare Tunnel, and local development.

## Relevant source files

- `docker-compose.yml` — service topology, volumes, profiles, port mappings
- `Dockerfile` — 3-stage build (deps → build → runner) for the `app` image
- `docker-entrypoint.sh` — container startup: env sync, DB path resolution, migrations
- `scripts/pack-exe.ts` — standalone distribution assembler (build → copy → prune → compile)
- `launcher/umanschat-launcher.cjs` — exe entry point: env sync, migrations, server launch, browser open
- `src/lib/tunnel.ts` — Cloudflare Tunnel lifecycle (Docker container vs downloaded binary)
- `src/app/api/tunnel/route.ts` — tunnel control API (start/stop/status)
- `.github/workflows/ci.yml` — CI: typecheck on push/PR
- `.github/workflows/release.yml` — release pipeline: Docker images + exe + GitHub Release
- `drizzle.config.ts` — Drizzle Kit migration config
- `.env.example` — full environment variable reference

## Docker deployment

Docker Compose is the primary deployment method. Six services form the full stack; the `app` service is UmansChat itself and the rest are supporting microservices.

### Services

| Service | Container image | Host→container port | Purpose |
|---------|-----------------|----------------------|---------|
| `app` | `ghcr.io/johmaru/umanschat-unofficial-app` | `3001→3000` | Next.js standalone server (the main application) |
| `cloudflared` | `cloudflare/cloudflared:latest` | — | Cloudflare Tunnel (profile `tunnel`, opt-in) |
| `scraper` | `ghcr.io/johmaru/umanschat-unofficial-scraper` | `8000` (internal) | Scrapling FastAPI web scraper |
| `embedder` | `ghcr.io/johmaru/umanschat-unofficial-embedder` | `8001→8001` | Python sentence-transformers embedding service |
| `searxng` | `searxng/searxng:latest` | `8081→8080` | SearXNG meta-search engine |
| `tor` | `dperson/torproxy:latest` | `9050` (internal) | Tor SOCKS proxy for anonymous scraping |

The `app` service depends on `embedder` and `scraper` (both `service_started`); `scraper` depends on `searxng`; `searxng` depends on `tor`. The `cloudflared` service is gated behind the `tunnel` profile and only starts when explicitly activated.

### Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| `./.env` | `/app/.env` | Environment config — GUI edits persist across rebuilds (not baked into the image) |
| `./data` | `/app/data` | SQLite database persistence (`data/umanschat.db` lives on the host) |
| `/var/run/docker.sock` | `/var/run/docker.sock` | Docker socket — lets the app start/stop the Tor container |
| `./docker-compose.yml` | `/app/docker-compose.yml:ro` | Compose file (read-only) — needed for `docker compose` invocations from inside the app |
| `umanschat-embedder-hf` (named) | `/root/.cache/huggingface` | HuggingFace model cache for the embedder |

### Environment

The `app` service reads `.env` via `env_file` and also sets several service-internal variables that point at sibling containers (e.g. `SCRAPER_URL=http://scraper:8000`, `EMBEDDER_URL=http://embedder:8001`, `SEARXNG_URL=http://searxng:8080`). Secrets (`AUTH_SECRET`, OAuth credentials) and user-tunable settings (`EMBED_*`, `WEB_SEARCH_*`, `TOR_PROXY`, etc.) come from `.env` so they can be edited at runtime through the Settings GUI. See [Settings & Environment](./settings-env.md) for the full variable list.

### Dockerfile (3-stage build)

The `app` image is built in three stages:

**Stage 1 — `deps` (base: `oven/bun:1.3`):** Installs native build tooling (`python3 make g++`), copies `package.json`/`bun.lock`/`bunfig.toml`, runs `bun install --frozen-lockfile`, then removes `@xenova/transformers`'s bundled `sharp` (not needed server-side).

**Stage 2 — `build` (base: `node:22-slim`):** Copies `node_modules` from the deps stage, copies the full source, rebuilds `better-sqlite3` for Node (the deps stage compiled it with Bun's toolchain), then runs `npx next build` with `DATABASE_URL=":memory:"` and `NODE_OPTIONS="--max-old-space-size=3072"`.

**Stage 3 — `runner` (base: `node:22-slim`):** The runtime image. Installs `ca-certificates curl gnupg sqlite3` plus the Docker CLI and Compose v2 plugin (downloaded from GitHub releases) so the app can manage the Tor container via the mounted socket. Then copies the build artifacts: `.next/` (including standalone server + static assets), `public/`, `package.json`, `drizzle/` migrations, `drizzle.config.ts`, `node_modules`, `scripts/`, and `.env.example`. The entrypoint is `docker-entrypoint.sh` and the default command is `node .next/standalone/server.js`.

### docker-entrypoint.sh

The entrypoint runs four steps before handing off to the server:

1. **Sync `.env`** — runs `node --experimental-strip-types /app/scripts/sync-env.ts` to append any new keys from `.env.example` into `.env`. Because `.env` is volume-mounted, this also updates the host file. Failure is non-fatal (warns and continues).

2. **Resolve `DATABASE_URL` to an absolute path** — the standalone server calls `process.chdir("/app/.next/standalone/")`, so a relative DB path would resolve to the wrong location. The entrypoint converts `:memory:`, empty, or relative paths to `/app/data/umanschat.db` (or `/app/<relative>`), then `mkdir -p` the directory.

3. **Remove stale WAL/SHM sidecars** — deletes `*.db-wal` and `*.db-shm` in the DB directory. The app uses `journal_mode=DELETE` (not WAL) because Docker Desktop bind mounts corrupt WAL `-shm` files. This cleanup runs on every start and is a no-op after the first restart.

4. **Run migrations** — `npx drizzle-kit migrate` creates all tables and indexes. Failure is non-fatal: the app starts anyway (with a warning) so operators can inspect a partially-migrated database.

Finally, `exec "$@"` replaces the entrypoint process with the server command.

### Starting the stack

```bash
# Pull prebuilt release images from GHCR and start
docker compose pull
docker compose up -d

# Or build from source (local development)
docker compose up -d --build
```

The app is then reachable at `http://localhost:3001`. To enable the Cloudflare Tunnel, add `--profile tunnel`:

```bash
docker compose --profile tunnel up -d
```

See [Cloudflare Tunnel](#cloudflare-tunnel) below for tunnel setup.

## Standalone exe (Windows)

The standalone distribution is a single double-clickable `umanschat.exe` plus its supporting files, built with Bun's `--compile` feature. The launcher (compiled into the exe) runs via the embedded Bun runtime, but spawns a bundled `node.exe` to run `server.js` — the app uses `better-sqlite3`, which Bun does not support. Both `umanschat.exe` and `node.exe` are included in the distribution, so end users need nothing else installed.

### pack-exe.ts pipeline

`scripts/pack-exe.ts` assembles the distribution into `dist/UmansChat/` in this order:

1. **Build** — `bun run build` with `DATABASE_URL=":memory:"` (build-time only; the real DB is created at runtime). Produces `.next/standalone/` via Next.js output-file tracing.

2. **Clean** — removes any prior `dist/UmansChat/` directory.

3. **Copy standalone output** — copies `.next/standalone/*` → `dist/UmansChat/`. On Windows, Next.js's output-file-tracing creates junctions (for `@xenova/transformers-<hash>` and `better-sqlite3-<hash>`). `cpSync` fails on junctions with `EPERM`, so the script detects junctions, skips them during the copy, and then copies their targets as real directories. Junctions point to absolute paths that would break at the distribution destination, so this step is essential.

4. **Copy assets** — copies `public/`, `.next/static/`, `drizzle/` (migrations), `drizzle.config.ts`, `scripts/sync-env.ts`, `.env.example`, `launcher/umanschat-launcher.cjs` (renamed to `umanschat.cjs`), and `package.json` (required by `bun build --compile`).

5. **Copy `node.exe`** — resolves `node` from PATH (via `where node`) and copies it into `dist/UmansChat/node.exe`. The launcher spawns this to run `server.js`, since the app uses `better-sqlite3` (unsupported by Bun).

6. **Prune tests** — recursively deletes `*.test.ts` and `*.test.tsx` files (Next.js's file tracing also copies these into standalone; they're not needed at runtime and bloat the package).

7. **Compile** — runs `bun build --compile` on `umanschat.cjs`, producing `umanschat.exe`. This embeds the Bun runtime. If compilation fails (e.g. Bun version mismatch), it falls back to writing `umanschat.bat` (`@echo off\r\nbun umanschat.cjs`) which requires Bun on the user's PATH.

### Launcher sequence

`launcher/umanschat-launcher.cjs` (compiled into the exe) runs on every launch:

1. **Resolve `appRoot`** — when compiled, uses `dirname(process.execPath)` (the exe's directory); when run under node/bun directly, uses `__dirname`. This matters because `bun build --compile` can make `__dirname` point to a temp extraction directory.

2. **Create `data/`** — ensures `<appRoot>/data/` exists for the SQLite database.

3. **Sync `.env`** — appends any new keys from `.env.example` into `.env` without modifying existing values. Mirrors the Docker entrypoint's sync step.

4. **Resolve `DATABASE_URL`** — converts the `.env` value to an absolute path (default `data/umanschat.db`). Like the Docker entrypoint, this is necessary because the standalone server calls `process.chdir(__dirname)`.

5. **Run migrations** — uses Drizzle's programmatic migrator (`drizzle-orm/bun-sqlite/migrator`) with the built-in `bun:sqlite` module. `better-sqlite3` cannot be loaded from inside a `bun build --compile` exe (its `bindings` module resolves to a virtual path). Opens the SQLite file, sets `journal_mode=WAL` (the exe doesn't suffer from Docker's bind-mount WAL corruption), runs migrations, then closes the connection. The server reopens the file on startup via `better-sqlite3` under Node.

6. **Start the server** — spawns the bundled `node.exe` (not `process.execPath`, which is the compiled launcher, not a general JS runtime) with `server.js`, inheriting stdio and passing `PORT` and the absolute `DATABASE_URL`. The app uses `better-sqlite3`, which Bun does not support — Docker runs `node server.js` for parity.

7. **Poll for readiness** — `GET http://localhost:<PORT>/` every 500ms (30s timeout). On success, opens the default browser via `start http://localhost:<PORT>` (Windows). On timeout, logs an error but leaves the server running.

### First-run experience

On first launch, the user sees:
- A console window with `[launcher]` progress lines.
- `.env` is created from `.env.example` (if absent) with all keys present.
- `data/umanschat.db` is created and migrations run.
- The browser opens to `http://localhost:3001` showing the login page.
- Because `userCount === 0`, the login page shows first-run admin registration. The first registered user becomes the admin and inherits any ownerless data. See [Authentication](./authentication.md).

The user must then edit `.env` to set `LLM_API_KEY`, `AUTH_SECRET`, etc., and restart the exe (or use the Settings GUI).

## CI

`.github/workflows/ci.yml` runs on every push and pull request to the `develop` and `main` branches. It has a single job:

**`typecheck`** (runs-on `ubuntu-latest`):
1. Checks out the repo.
2. Sets up Bun 1.3 via `oven-sh/setup-bun@v2`.
3. `bun install --frozen-lockfile`.
4. `bun run typecheck` — runs `tsc --noEmit`.

Docker image builds and exe packaging are **not** part of CI — they are gated to the manual Release workflow. Lint and test are not yet wired into CI (noted in the workflow comments).

## Release

`.github/workflows/release.yml` is triggered **manually** via `workflow_dispatch` from the GitHub Actions tab, requiring a `version` input (e.g. `1.2.3`, no leading `v`). It produces three GHCR Docker images and a Windows exe zip, then publishes a GitHub Release. The pipeline has four jobs:

### Job graph

```
prepare ──┬──> docker (3 GHCR images) ──┐
           └──> exe (windows-latest) ──┴──> release (GitHub Release + zip)
```

### prepare

Runs on `ubuntu-latest`. Derives the shared version and git tag from the `version` input:
- `version` = the input as-is (e.g. `1.2.3`)
- `tag` = `v` + version (e.g. `v1.2.3`)

Both are exposed as job outputs consumed by the downstream jobs, ensuring a single source of truth for the version string.

### docker

Runs on `ubuntu-latest` (needs `prepare`). Logs into GHCR with `GITHUB_TOKEN`, sets up Docker Buildx, then builds and pushes three images — each tagged with both `:latest` and `:<version>`:

| Image | Context | Dockerfile |
|-------|---------|------------|
| `ghcr.io/johmaru/umanschat-unofficial-app` | `.` | `./Dockerfile` |
| `ghcr.io/johmaru/umanschat-unofficial-scraper` | `./scraper` | `./scraper/Dockerfile` |
| `ghcr.io/johmaru/umanschat-unofficial-embedder` | `./embedder` | `./embedder/Dockerfile` |

Each build uses GitHub Actions cache (`type=gha`, `mode=max`) to speed up subsequent releases.

### exe

Runs on `windows-latest` (needs `prepare`). Builds the standalone distribution natively (no cross-compilation — matches what end users download):

1. Setup Bun 1.3, `bun install --frozen-lockfile`.
2. `bun run pack:exe` (with `DATABASE_URL=":memory:"`) — runs `scripts/pack-exe.ts`.
3. Zip the `dist/UmansChat/` contents into `UmansChat-<version>-windows-x64.zip` via PowerShell `Compress-Archive`.
4. Upload the zip as a workflow artifact (`umanschat-exe-<version>`, 5-day retention).

### release

Runs on `ubuntu-latest` (needs `prepare`, `docker`, **and** `exe`). Because it depends on both artifact jobs, a failure in either blocks the release — a Docker build failure cannot publish an exe-only release.

1. Downloads the exe zip artifact.
2. Creates/updates a GitHub Release via `softprops/action-gh-release@v2`:
   - Tag: `v<version>` (e.g. `v1.2.3`)
   - Name: `UmansChat v<version>`
   - Asset: `UmansChat-<version>-windows-x64.zip`
   - `prerelease: true` if the version contains a hyphen (e.g. `1.2.3-rc1`)
   - `generate_release_notes: true` — auto-generates from commit history / PR titles

Required permissions: `contents: write` (create release + upload asset) and `packages: write` (push to GHCR).

## Cloudflare Tunnel

UmansChat optionally exposes the app over public HTTPS via a Cloudflare named tunnel, without port forwarding or a reverse proxy. This is useful for accessing the app remotely or for OAuth callbacks that require HTTPS.

`src/lib/tunnel.ts` detects the execution environment and manages the tunnel accordingly. The core branch is Docker vs non-Docker:

```typescript
export function isDockerEnv(): boolean {
  return existsSync("/var/run/docker.sock");
}
```

### Three operating modes

**1. Docker Compose (container profile):** When `/var/run/docker.sock` exists, the tunnel is managed as a compose service. The `cloudflared` service in `docker-compose.yml` is gated behind the `profiles: ["tunnel"]` flag — it does not start unless activated with `--profile tunnel`. Starting/stopping is done via:

```bash
# Start (used by src/lib/tunnel.ts internally)
docker compose --profile tunnel up -d --force-recreate cloudflared

# Stop
docker compose --profile tunnel stop cloudflared
```

The `--force-recreate` flag ensures a running container with a stale `TUNNEL_TOKEN` env var is recreated when the token changes via the Settings GUI.

**2. Standalone exe (downloaded binary):** When not in Docker and running as a compiled exe, `startExeTunnel()` downloads the `cloudflared` binary to `data/cloudflared/` (resolved relative to `dirname(process.execPath)`), then spawns it as a child process:

```typescript
cloudflaredProcess = spawn(binaryPath, ["tunnel", "run", "--token", token], { stdio: "ignore" });
```

The process is kept in a module-level variable and stopped via `SIGTERM`.

**3. Node/Bun direct (downloaded binary):** When running directly under node or bun (e.g. `bun run dev` or `node umanschat.cjs`) rather than as a compiled exe, the same exe code path is used — the only difference is that `appRoot` resolves to `process.cwd()` instead of the exe directory, so the binary lands in `data/cloudflared/` relative to the working directory.

> macOS is unsupported — `getBinaryName()` throws for non-win32/non-linux platforms because `.tgz` extraction would be required (not implemented).

### Binary management

The cloudflared binary is **pinned** to a specific version and verified by SHA256 — there is no auto-update:

```typescript
const CLOUDFLARED_VERSION = "2024.12.2";
const CLOUDFLARED_HASHES: Record<string, string> = {
  "cloudflared-windows-amd64.exe":
    "c2f4a3c3ea4c62eed562ede027d586a6044d35517e335e642f4e9783e651e4a3",
  "cloudflared-linux-amd64":
    "5237675a5e806120729acc78c5be02f9db5f406717699587abfa72b49b39fe40",
};
```

Security guarantees (documented in the module header):
- **Pinned version** — `2024.12.2`. Upgrading requires a developer to update the constants and rebuild.
- **SHA256 verification** — `downloadCloudflared()` computes the hash of the downloaded file and compares it to the pinned value. If the binary already exists and the hash matches, the download is skipped. A mismatch causes a hard error (no fallback).
- **HTTPS only** — downloads from `https://github.com/cloudflare/cloudflared/releases/download/...`. A custom `httpsDownload()` helper follows up to 5 redirects.
- **No auto-update** — the binary is only fetched when the tunnel is started and the cached copy is missing or hash-mismatched.

### Token handling

The tunnel token (`TUNNEL_TOKEN`) is treated as a secret throughout:

- **`GET /api/tunnel`** returns only `hasToken: boolean` — never the token itself.
- **`POST /api/tunnel`** accepts a `token` in the body; if omitted, falls back to the existing `process.env.TUNNEL_TOKEN`. An empty token returns `400`.
- **Settings GUI** — when saving via the GUI, an empty string is ignored (the existing `.env` value is preserved), so clearing the field in the form doesn't wipe the token.
- The token and `AUTH_URL` are written to `.env` and `process.env` simultaneously, then `startTunnel(token, { force: true })` is called — the `force` flag stops any running tunnel and restarts it to reliably reflect the new token.

### AUTH_URL dynamic switching

When a tunnel is started, the public HTTPS hostname must be set as `AUTH_URL` so that Auth.js generates correct callback URLs (for Google OAuth and Notion OAuth). Critically, this takes effect **without a restart**:

- `POST /api/tunnel` sets `process.env.AUTH_URL = authUrl` directly.
- NextAuth reads `AUTH_URL` per-request via its `reqWithEnvURL` mechanism, so the new value is picked up on the next HTTP request.
- `AUTH_URL` must start with `https://` (enforced by the API route — a non-HTTPS value returns `400`).

This is also the base URL for Notion's OAuth redirect URI (`{AUTH_URL}/api/connections/notion/callback`) and Google's (`{AUTH_URL}/api/auth/callback/google`), so it must match the URIs registered in the Notion and Google developer consoles.

### Setup steps

1. Create a named tunnel at [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) → Networks → Tunnels.
2. Configure the tunnel's public hostname to route to `Service=http://app:3000` (Docker) or `http://localhost:3001` (exe).
3. Copy the issued token into `TUNNEL_TOKEN` in `.env` (or enter it in the Settings GUI).
4. Set `AUTH_URL` to the tunnel's public HTTPS URL.
5. Start the tunnel:
   - **Docker:** `docker compose --profile tunnel up -d`
   - **exe / Node:** use the Settings GUI toggle, or the API: `POST /api/tunnel` with `{ "token": "...", "authUrl": "https://..." }`

## Local development

### Prerequisites

- [Bun](https://bun.sh/) 1.3+ (runtime, package manager, and build tool)
- Node.js 22+ (for `next build` and native module rebuilds — the Docker build uses `node:22-slim` for the build and runner stages)

### Setup

```bash
# 1. Install dependencies
bun install

# 2. Create .env from the example and fill in secrets
cp .env.example .env
# Edit .env: set LLM_API_KEY, AUTH_SECRET (bunx auth secret), etc.

# 3. Run migrations (creates data/umanschat.db)
bunx drizzle-kit migrate
```

The `dev` script has a `predev` hook that runs `scripts/sync-env.ts` (syncs `.env` with `.env.example`) and `bunx drizzle-kit migrate` automatically, so you can also just run:

```bash
bun run dev
```

This starts the Next.js dev server (default `http://localhost:3000`). The dev server uses `next dev`, not the standalone build — there is no `server.js` or `docker-entrypoint.sh` involved.

### Available scripts

| Script | Command | What it does |
|--------|---------|--------------|
| `dev` | `bun run dev` | Starts `next dev` (runs `predev` first: sync-env + migrate) |
| `build` | `bun run build` | `next build` (produces `.next/standalone/`) |
| `start` | `bun run start` | `next start` (production server, non-standalone) |
| `pack:exe` | `bun run pack:exe` | Runs `scripts/pack-exe.ts` — builds the exe distribution |
| `typecheck` | `bun run typecheck` | `tsc --noEmit` |
| `lint` | `bun run lint` | `eslint` |
| `test` | `bun run test` | `vitest run` |
| `test:watch` | `bun run test:watch` | `vitest` (watch mode) |

### Optional Docker services for local dev

For features that need the supporting microservices (web search, HTTP embeddings, Tor proxy), you can start just those containers without building the `app` image:

```bash
# Start scraper + searxng + tor (for web search / scraping)
docker compose up -d scraper searxng tor

# Start the embedder (for EMBED_PROVIDER=http)
docker compose up -d embedder
```

Then point your `.env` at the local ports:
- `SCRAPER_URL=http://localhost:8000`
- `SEARXNG_URL=http://localhost:8081`
- `EMBEDDER_URL=http://localhost:8001`
- `TOR_PROXY=socks5://localhost:9050` (or `SCRAPE_PROXY`)

Without these services, the app still works — local ONNX embeddings (`EMBED_PROVIDER=local`) require no external service, and chat works without web search. See [Settings & Environment](./settings-env.md) for configuring each subsystem.

## Parity rule: exe and Docker must contain the same application code

The standalone exe and the Docker image are two packaging of the **same application**. Both are built from the same source tree and must remain in sync:

- **Same build command** — both run `next build` (the Dockerfile calls `npx next build`; `pack-exe.ts` calls `bun run build`, which resolves to the same `next build`). The only difference is that the Docker build sets `DATABASE_URL=":memory:"` and `NODE_OPTIONS="--max-old-space-size=3072"` for the heavier Node-based build.
- **Same migrations** — both copy `drizzle/` and `drizzle.config.ts`. Docker runs `npx drizzle-kit migrate` in the entrypoint; the exe uses Drizzle's programmatic migrator (`drizzle-orm/better-sqlite3/migrator`) in the launcher. Both target the same `drizzle/` folder.
- **Same env sync** — both run `scripts/sync-env.ts` (Docker via `node --experimental-strip-types`; exe via the launcher's `syncEnv()` which re-implements the same logic in plain JS).
- **Same DB path resolution** — both convert `DATABASE_URL` to an absolute path because the standalone server calls `process.chdir()`.
- **Same release** — the Release workflow builds both artifacts from the same commit in a single run, so a given version tag always has matching Docker images and exe.

The one intentional difference is SQLite journal mode: Docker uses `journal_mode=DELETE` (set in `src/db/index.ts`) to avoid Docker Desktop bind-mount WAL corruption, while the exe uses `journal_mode=WAL` (set in the launcher's `runMigrations()`) for better concurrency. Both open the same schema and migrations.

When adding a new runtime dependency or build artifact, it must be added to **both** the Dockerfile's runner stage copy list and `pack-exe.ts`'s copy steps, or the two deployments will diverge.

## See also

- [Settings & Environment](./settings-env.md) — full `.env` variable reference, the Settings API, and runtime cache invalidation
- [Architecture Overview](./architecture.md) — high-level system architecture and service topology
- [Authentication](./authentication.md) — Auth.js v5, first-run admin, OAuth callback URLs (which depend on `AUTH_URL`)
- [Database](./database.md) — SQLite setup, Drizzle ORM, the migration system used by both deployment paths
