# UmansChat Sandbox — Python + Node image (v0.4)
#
# Prebuilt image for Tier 1 `code_run` sandbox executions.
# Ships Python 3.12 (slim) and Node.js (distro) so the policy gate can
# accept language: "python" | "javascript". No pip packages beyond stdlib;
# no network access at runtime (--network none is set by the orchestrator).
#
# Build:
#   docker build -t umanschat-sandbox-python:v0.4 sandbox/python
#
# Smoke:
#   docker run --rm umanschat-sandbox-python:v0.4 python -c "print(1)"
#   docker run --rm umanschat-sandbox-python:v0.4 node -e "console.log(1)"
#
# The image name is historical (it started python-only). Both runtimes live
# in this single tag in v0.4; a future split would introduce
# umanschat-sandbox-python-js:v0.5 etc.

FROM python:3.12-slim-bookworm

# Install Node.js from Debian repos. --no-install-recommends keeps the layer
# small. Clean the apt lists to reduce image size.
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -u 10001 sandbox

# Run as the non-root sandbox user. The orchestrator bind-mounts code into
# /work read-only; the user must be able to read it (mode is controlled by
# the host staging dir).
USER sandbox
WORKDIR /work

# No CMD/ENTRYPOINT: the orchestrator passes the full command
# (e.g. `python main.py`, `node main.js`) as docker run args.
