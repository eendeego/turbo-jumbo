#!/usr/bin/env bash
set -euo pipefail

# Build the production image and export it as the deploy tarball, stamping the
# image with its release identity: TJ_COMMIT always, TJ_RELEASE only when the
# build is exactly a clean tagged revision — the same rule
# lib/version/app-version.ts applies at runtime, so the running container
# reports `dev: false` only for official release builds.

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$SCRIPT_DIR/..
cd "$REPO_ROOT"

TJ_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || true)
TJ_RELEASE=""
if [[ -z "$(git status --porcelain 2>/dev/null)" ]]; then
  TJ_RELEASE=$(git describe --tags --exact-match HEAD 2>/dev/null || true)
fi

podman build -t turbo-jumbo \
  --build-arg TJ_RELEASE="$TJ_RELEASE" \
  --build-arg TJ_COMMIT="$TJ_COMMIT" \
  .
podman save turbo-jumbo | gzip >turbo-jumbo.tar.gz
