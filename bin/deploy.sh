#!/usr/bin/env bash
set -euo pipefail

# Host-specific settings come from an env file shared with watch-deploy.sh.
# Default: .env at the repo root (gitignored); override with ENV_FILE.
# See bin/watch-deploy.env.sample for the available variables.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$SCRIPT_DIR/..
ENV_FILE=${ENV_FILE:-$REPO_ROOT/.env}

if [[ -f "$ENV_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$ENV_FILE"
fi

: "${DEST:?set DEST in $ENV_FILE — directory the tarball and watch-deploy.sh are deployed to}"

# Must match the tarball name `bun docker:build` writes and the TARBALL the
# deploy host's watch-deploy env points at.
TARBALL_NAME=${TARBALL_NAME:-turbo-jumbo.tar.gz}

cd "$REPO_ROOT"

# Build the Docker image and export it as a tarball ($TARBALL_NAME)
bun docker:build

# Copy watch-deploy.sh (and its env sample) so the server always runs the latest version
cp bin/watch-deploy.sh "$DEST/watch-deploy.sh"
cp bin/watch-deploy.env.sample "$DEST/watch-deploy.env.sample"

# Copy to a temporary name so the destination is never seen in a partial state
cp "$TARBALL_NAME" "$DEST/$TARBALL_NAME.tmp"

# Atomic rename into the final location picked up by watch-deploy.sh
mv "$DEST/$TARBALL_NAME"{.tmp,}

# Free up disk space used by dangling images and containers from the build
podman system prune -f
