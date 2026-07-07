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

exec node node_modules/tsx/dist/cli.mjs autoresearch/bench.ts
