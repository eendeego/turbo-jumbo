#!/usr/bin/env bash
set -euo pipefail

# The whole demo pipeline in one command: start the isolated demo server,
# record the storyline (bin/record-demo.ts, per docs/demo-script.md),
# accelerate the waits and emit a GitHub-ready mp4 (bin/demo-postprod.sh),
# then stop the server and restore what `next dev` touched. Artifacts land
# in demo-out/ (override with DEMO_OUT_DIR); the last lines echo their paths.
#
# Usage:
#   bin/make-demo.sh [-w START:END:SPEED]...
#
# Acceleration windows default to the current take's documented ones
# (docs/demo-script-timestamps.md); the first -w drops all defaults. If a
# take's pacing shifts, sanity-check the windows against the beat table the
# recorder prints.

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$SCRIPT_DIR/..
cd "$REPO_ROOT"

PORT=${DEMO_PORT:-3998}
BASE="http://localhost:$PORT"
OUT_DIR=${DEMO_OUT_DIR:-demo-out}

WINDOWS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        -w) WINDOWS+=(-w "${2:?-w needs START:END:SPEED}"); shift 2 ;;
        *) echo "error: unknown argument: $1" >&2; exit 1 ;;
    esac
done
if [[ ${#WINDOWS[@]} -eq 0 ]]; then
    WINDOWS=(-w 124:141:8 -w 165:214:8 -w 222.5:232:4)
fi

# Stop the server we started (never one we merely reused), remove its
# isolated dist dir, and put back the exact tsconfig.json bytes — `next dev`
# rewrites the file on startup.
SERVER_PID=''
TSCONFIG_SNAPSHOT=''
cleanup() {
    if [[ -n $SERVER_PID ]]; then
        kill -- "-$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
        rm -rf .next-verify
    fi
    if [[ -n $TSCONFIG_SNAPSHOT ]]; then
        cp "$TSCONFIG_SNAPSHOT" tsconfig.json
        rm -f "$TSCONFIG_SNAPSHOT"
    fi
}
trap cleanup EXIT

if curl -sf -o /dev/null "$BASE/"; then
    echo "reusing the server already running on :$PORT (will not stop it)"
else
    TSCONFIG_SNAPSHOT=$(mktemp)
    cp tsconfig.json "$TSCONFIG_SNAPSHOT"
    SERVER_LOG=$(mktemp)
    echo "starting the isolated demo server on :$PORT (log: $SERVER_LOG)"
    # direnv loads .envrc so the hf CLI the app spawns gets HF_TOKEN and Xet
    # acceleration; setsid puts the whole next-dev tree in one process group
    # so cleanup can kill it as a unit.
    if command -v direnv >/dev/null; then
        setsid direnv exec "$REPO_ROOT" bash -c \
            "NEXT_DEV_INDICATORS=0 NEXT_DIST_DIR=.next-verify bunx next dev --port $PORT" \
            >"$SERVER_LOG" 2>&1 &
    else
        echo "warning: direnv not found — .envrc env (HF_TOKEN, Xet) will be missing" >&2
        setsid env NEXT_DEV_INDICATORS=0 NEXT_DIST_DIR=.next-verify \
            bunx next dev --port "$PORT" >"$SERVER_LOG" 2>&1 &
    fi
    SERVER_PID=$!
    for _ in $(seq 1 60); do
        curl -sf -o /dev/null "$BASE/" && break
        kill -0 "$SERVER_PID" 2>/dev/null ||
            { echo "server died:" >&2; tail "$SERVER_LOG" >&2; exit 1; }
        sleep 1
    done
    curl -sf -o /dev/null "$BASE/" ||
        { echo "server never came up:" >&2; tail "$SERVER_LOG" >&2; exit 1; }
fi

mkdir -p "$OUT_DIR"
RECORD_LOG=$(mktemp)
DEMO_URL=$BASE DEMO_OUT_DIR=$OUT_DIR bun bin/record-demo.ts | tee "$RECORD_LOG"

# Playwright names the webm after an internal page id — give the take a
# stable, dated name before post-production.
RAW=$(sed -n 's/^VIDEO: //p' "$RECORD_LOG" | tail -1)
rm -f "$RECORD_LOG"
[[ -n $RAW && -f $RAW ]] || { echo "error: recorder did not produce a video" >&2; exit 1; }
TAKE="$OUT_DIR/turbo-jumbo-demo-$(date +%Y-%m-%d).webm"
mv "$RAW" "$TAKE"
echo "raw take: $TAKE"

bin/demo-postprod.sh "$TAKE" "${WINDOWS[@]}"
