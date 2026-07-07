#!/bin/sh
# autoresearch.sh — deterministic benchmark entrypoint for search-query diversification.
#
# Runs autoresearch/bench.ts through tsx (project TS toolchain, resolves @/ aliases)
# with LLM_BASE_URL unset so buildDisableReasoningParams uses the static
# MODEL_REASONING map (no network). Prints METRIC lines to stdout.
#
# Usage: sh autoresearch.sh
set -e

# Determinism: no provider URL => isUmansProvider() false => no model-info fetch.
unset LLM_BASE_URL
unset LLM_API_KEY

# Locate node: prefer PATH, fall back to common Windows install locations so the
# experiment runner (which may use a minimal PATH without nodejs) still works.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for cand in \
    "/c/Program Files/nodejs/node.exe" \
    "/mnt/c/Program Files/nodejs/node.exe" \
    "C:/Program Files/nodejs/node.exe" \
    "$LOCALAPPDATA/Programs/nodejs/node.exe" \
    "$HOME/.bun/bin/bun.exe"; do
    if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "bench failed: node not found on PATH or common install locations" >&2
  exit 127
fi
exec "$NODE_BIN" node_modules/tsx/dist/cli.mjs autoresearch/bench.ts
