# Sandbox Python+Node Image (v0.4)

Prebuilt Docker image for UmansChat's Tier 1 `code_run` sandbox. Ships Python
3.12 and Node.js so the `sandbox_run` tool can execute inline `python` or
`javascript` code in an isolated, network-less, read-only container.

## Build

From the repo root:

```bash
docker build -t umanschat-sandbox-python:v0.4 sandbox/python
```

You only need to build this once per host. The image is **not** published to
GHCR in v0.4 — it is a local dev prerequisite when the sandbox feature is on.

## Smoke test

```bash
docker run --rm umanschat-sandbox-python:v0.4 python -c "print(1)"
docker run --rm umanschat-sandbox-python:v0.4 node -e "console.log(1)"
```

Both should print `1`.

## How the orchestrator runs it

The chat route calls `runSandbox(args)`, which builds an argv equivalent to:

```bash
docker run --rm \
  --name sandbox-<runId> \
  --network none \
  --memory 256m \
  --pids-limit 64 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -v <stagingDir>:/work:ro \
  -w /work \
  umanschat-sandbox-python:v0.4 \
  python main.py    # or: node main.js
```

- `--network none` — no outbound network from the container.
- `--read-only` + `--tmpfs /tmp` — root fs is immutable; only `/tmp` is
  writable (and `noexec`, so binaries dropped there cannot be executed).
- `--memory` / `--pids-limit` — cap host resource abuse.
- The staging dir holds the user's inline code (written by the orchestrator)
  and is mounted **read-only** at `/work`. It is deleted after the run.

## Runtime languages

| Language     | Command           | Status |
|--------------|-------------------|--------|
| `python`     | `python main.py`  | ✅ v0.4 |
| `javascript` | `node main.js`    | ✅ v0.4 |
| `typescript` | —                 | ❌ rejected by policy (no transpile path yet) |
| `bash`       | —                 | ❌ rejected by policy (image has no bash guarantee) |

## No pip / npm install

The image ships only stdlib + the distro Node. There is **no** `pip install`
or `npm install` path in v0.4. Code that imports third-party packages will
fail at runtime — the orchestrator returns a `container_failed` result with
the stderr.

## CI

CI does **not** build this image. It is a local dev prerequisite only. A
future optional CI job (`sandbox-image`) may build and push it.

## App-in-Docker (Docker-in-Docker sibling)

If the UmansChat app itself runs inside Docker Compose, it needs access to
the host Docker socket to spawn sibling containers. Add to `docker-compose.yml`:

```yaml
# app:
#   volumes:
#     - /var/run/docker.sock:/var/run/docker.sock
```

Without the socket, `shouldExposeSandboxTool()` returns `false` and the
`sandbox_run` tool is not offered to the LLM. See
`.agents/skills/umanschat-install/SKILL.md` for the full setup.

## Windows path conversion

On Windows hosts, Docker Desktop generally accepts `C:\Users\...` paths as
bind-mount sources in recent versions. If you hit `invalid mount path`
errors, verify your Docker Desktop is up to date. The orchestrator passes
the native path through (`toDockerVolumePath` is a no-op in v0.4); a future
revision may add explicit `/c/...` conversion if needed.
