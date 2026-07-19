#!/usr/bin/env bash
set -euo pipefail

# The isolated dev server used for e2e verification and UI captures — never
# the user's own `bun dev`. Runs through direnv so .envrc env (HF_TOKEN, Xet)
# reaches the `hf` CLI the app spawns, with the dev-tools bubble hidden and a
# separate dist dir so the user's server is untouched. Runs in the foreground;
# stop it with Ctrl-C (or TaskStop). On exit it removes the verify dist dir
# and restores the tsconfig.json that `next dev` always rewrites.
#
# Usage:
#   bin/verify-server.sh [port]   # default port 3998

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$SCRIPT_DIR/..
cd "$REPO_ROOT"

PORT=${1:-3998}

cleanup() {
  rm -rf .next-verify
  jj restore --from @- tsconfig.json 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

NEXT_DEV_INDICATORS=0 NEXT_DIST_DIR=.next-verify direnv exec . \
  bunx next dev --port "$PORT"
