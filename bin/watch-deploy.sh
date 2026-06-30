#!/bin/bash
set -euo pipefail

# Host-specific paths and settings come from an env file, not this script.
# Default: .env at the repo root (gitignored); override with ENV_FILE.
# See bin/watch-deploy.env.sample for the available variables.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE=${ENV_FILE:-$SCRIPT_DIR/../.env}

if [[ -f "$ENV_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$ENV_FILE"
fi

: "${TARBALL:?set TARBALL in $ENV_FILE — image tarball to watch and load}"
: "${CONFIG_FILE:?set CONFIG_FILE in $ENV_FILE — host path to config.yaml}"
: "${MODEL_MOUNTS:?set MODEL_MOUNTS in $ENV_FILE — space-separated host dirs mounted rw at the same path in the container}"

CONTAINER_NAME=${CONTAINER_NAME:-turbo-jumbo}
IMAGE_NAME=${IMAGE_NAME:-turbo-jumbo}
PORT=${PORT:-3000}
POLL_INTERVAL=${POLL_INTERVAL:-2}
DEBOUNCE=${DEBOUNCE:-1}
DIR=$(dirname "$TARBALL")
FILE=$(basename "$TARBALL")

deploy() {
    if podman container exists "$CONTAINER_NAME" 2>/dev/null; then
        echo "Stopping existing container…"
        podman stop "$CONTAINER_NAME"
        podman rm "$CONTAINER_NAME"
    fi

    echo "Loading image…"
    podman load < "$TARBALL"

    volume_args=()
    for dir in $MODEL_MOUNTS; do
        volume_args+=(-v "$dir:$dir:rw")
    done

    echo "Starting container…"
    podman run -d --name "$CONTAINER_NAME" \
        -p "$PORT:3000" \
        -v "$CONFIG_FILE:/config/config.yaml:ro" \
        "${volume_args[@]}" \
        "$IMAGE_NAME"

    echo "Container started."
}

FIFO=$(mktemp -u)
mkfifo "$FIFO"
cleanup() {
    trap - EXIT INT TERM
    echo "Shutting down…"
    rm -f "$FIFO"
    if podman container exists "$CONTAINER_NAME" 2>/dev/null; then
        echo "Stopping container…"
        podman stop "$CONTAINER_NAME"
        podman rm "$CONTAINER_NAME"
    fi
    kill 0
}
trap cleanup EXIT INT TERM

# inotifywait watcher
(
    while true; do
        event=$(inotifywait -e close_write,moved_to,attrib -q --format '%f' "$DIR")
        [[ "$event" == "$FILE" ]] && echo inotify > "$FIFO"
    done
) &

# stat polling watcher (NFS fallback)
(
    last_mtime=$(stat -c '%Y' "$TARBALL")
    while true; do
        sleep "$POLL_INTERVAL"
        mtime=$(stat -c '%Y' "$TARBALL")
        if [[ "$mtime" != "$last_mtime" ]]; then
            last_mtime="$mtime"
            echo stat > "$FIFO"
        fi
    done
) &

deploy
last_deployed=0
echo "Watching $TARBALL for changes…"

while read -r source < "$FIFO"; do
    now=$(date +%s)
    if (( now - last_deployed >= DEBOUNCE )); then
        echo "$(date): Change detected via $source, reloading…"
        deploy
        last_deployed=$(date +%s)
    fi
done
