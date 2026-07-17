# UmansChat Install Skill

Setup and verification guide for the sandbox (`sandbox_run`) feature (v0.4).

> ⚠️ **Experimental feature (v0.4).** This feature is under active development.
> The API, error codes, and image tag may change without notice. Tier 2/3
> presets (file inspection, malware analysis) are not yet implemented.
> See `docs/superpowers/specs/2026-07-15-sandbox-architecture-design.md`.

This skill does **not** replace `AGENTS.md` coding rules. It is a setup
recipe for developers who want the isolated code-execution tool working
locally or in Docker Compose.

## Prerequisites

- **Docker Desktop** (Windows / macOS) or **Docker Engine** (Linux).
  - On Windows, use the WSL2 backend.
  - Verify: `docker info` exits 0 and prints a Server Version.
- The UmansChat app must be able to reach the `docker` CLI from its process.
  - Native exe / dev (`bun run dev`): the Docker Desktop daemon is reachable
    directly.
  - Docker Compose: the app container needs the host Docker socket mounted
    (already configured in `docker-compose.yml`) to spawn sibling sandbox
    containers.

## Quick start (Docker Compose — recommended)

1. Build the sandbox image (first time only):

   ```bash
   docker compose --profile sandbox build
   ```

   This builds `umanschat-sandbox-python:v0.4` into the host's image store.
   The `sandbox` service is profile-gated — it builds but does not start.

2. Build and start the app:

   ```bash
   docker compose up -d --build
   ```

   The app container has the `docker` CLI installed (via `Dockerfile`) and
   the host Docker socket mounted (`docker-compose.yml`), so it can spawn
   sandbox siblings.

3. Verify in a chat: ask the model to "run `print(2+2)` in the python
   sandbox". The tool should fire and return sanitized stdout.

## Quick start (native / dev — `bun run dev`)

1. Build the prebuilt sandbox image once:

   ```bash
   docker build -t umanschat-sandbox-python:v0.4 sandbox/python
   ```

2. Smoke-test both runtimes:

   ```bash
   docker run --rm umanschat-sandbox-python:v0.4 python -c "print(1)"
   docker run --rm umanschat-sandbox-python:v0.4 node -e "console.log(1)"
   ```

   Both should print `1`.

3. Start the app. The `sandbox_run` tool is auto-exposed to the LLM when
   Docker is reachable and the image is present (`SANDBOX_ENABLED=auto`).

## What happens without the image

If the sandbox image is not built locally, `shouldExposeSandboxTool()`
returns `false` and the `sandbox_run` tool is **not** offered to the LLM.
The app runs normally — the feature is simply off. This is intentional:
no error, no half-enabled state.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `SANDBOX_ENABLED` | `auto` | `auto` = enable if Docker + image present; `true` = require Docker (fail tool if missing); `false` = force off |
| `SANDBOX_IMAGE` | `umanschat-sandbox-python:v0.4` | Prebuilt image tag (must exist locally) |
| `SANDBOX_MIN_FREE_MEM_PERCENT` | `15` | Reject runs when free mem % below this |
| `SANDBOX_MAX_CONCURRENT` | `1` | Max simultaneous sandbox containers per app process |
| `SANDBOX_DEFAULT_TIMEOUT_SEC` | `30` | code_run wall-clock timeout |
| `SANDBOX_STDOUT_MAX_BYTES` | `4096` | stdout/stderr char cap after sanitization |

## Verifying the tool is exposed

The chat route calls `getSandboxToolsForRequest()` once per request. When it
returns a non-empty array, `sandbox_run` is in the tool list sent to the LLM.

Quick checks:

- `docker info` → exits 0.
- `docker image inspect umanschat-sandbox-python:v0.4` → exits 0.
- In a chat, the model can call `sandbox_run` with inline `code`.

If the tool is missing, the most common cause is the image not being built
locally. v0.4 does **not** publish the sandbox image to GHCR — it is a local
dev prerequisite.

## Common failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `sandbox_run` tool not offered | Docker not reachable, or image not built | `docker info`; `docker compose --profile sandbox build` (Compose) or `docker build -t umanschat-sandbox-python:v0.4 sandbox/python` (native) |
| `image_missing` error at run time | Image tag mismatch or not built | Verify `SANDBOX_IMAGE` env matches the built tag |
| `docker_unavailable` at run time | App-in-Compose without socket mount | Verify `/var/run/docker.sock` is mounted in `docker-compose.yml` |
| `insufficient_host_memory` | Free mem below `SANDBOX_MIN_FREE_MEM_PERCENT` | Close other apps or lower the threshold (not recommended below 10) |
| `concurrent_limit` | Another sandbox run is in progress | Wait, or raise `SANDBOX_MAX_CONCURRENT` (caveat: each container caps memory) |
| `timeout` | Code ran longer than `SANDBOX_DEFAULT_TIMEOUT_SEC` | Increase the timeout, or fix the code (infinite loops hang the container) |
| `container_failed` | Container could not start (e.g. `docker run` spawn error) | Check `docker run` works manually; verify PATH |
| `invalid mount path` (Windows) | Docker Desktop path conversion | Update Docker Desktop; run on a Linux host if conversion persists |

## Security notes (v0.4 scope)

- The sandbox is Docker-only. No process-isolation fallback (spec §12.1 D1).
- The LLM never controls the image name or network mode — these are fixed by
  the orchestrator (`--network none`, image from `SANDBOX_IMAGE` only).
- Inline `code` only (Tier 1). Attached files / `inputRef` are rejected with
  `tier_forbidden` until Tier 2+ is implemented (spec §7.2).
- `run_command` (host whitelist) remains unchanged and is **not** replaced by
  the sandbox (spec §8.1).
