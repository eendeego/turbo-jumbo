#!/usr/bin/env bash
set -euo pipefail

# Cut a release: stamp the changelog's Unreleased section with the new
# version, bump package.json, commit, move the main bookmark, create the
# annotated tag, push branch and tag to both remotes, and publish the
# changelog section as release notes on GitHub and Forgejo.
#
# Usage:
#   bin/release.sh <version>          e.g. bin/release.sh 0.2.0
#
# Requires a clean jj working copy and a non-empty Unreleased section in
# CHANGELOG.md. Release publication wants API tokens — GITHUB_TOKEN and
# FORGEJO_TOKEN, exported by .envrc (direnv) or a repo-root .env; a missing
# token skips that forge's release (the tag is still pushed) and prints what
# to do by hand.

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$SCRIPT_DIR/..
cd "$REPO_ROOT"

ENV_FILE=${ENV_FILE:-$REPO_ROOT/.env}
if [[ -f "$ENV_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$ENV_FILE"
fi

# Forge coordinates come from the git remotes, so no machine, domain, or
# account names live in this file: `origin` is the Forgejo source of truth,
# `github` the public mirror.
repo_path() { # owner/repo from an ssh://, https://, or scp-style remote URL
    git remote get-url "$1" |
        sed -E 's#\.git$##; s#^[a-z+]+://[^/]+/##; s#^([^@]+@)?[^:/]+:##'
}
remote_host() {
    git remote get-url "$1" |
        sed -E 's#^[a-z+]+://([^@/]+@)?([^:/]+).*#\2#; t; s#^([^@]+@)?([^:/]+):.*#\2#'
}
GITHUB_REPO=$(repo_path github)

VERSION=${1:?usage: bin/release.sh <version>   e.g. bin/release.sh 0.2.0}
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: '$VERSION' is not a plain semver (X.Y.Z)" >&2
    exit 1
fi
TAG="v$VERSION"

# --- Preconditions --------------------------------------------------------

if [[ "$(jj log --no-graph -r @ -T 'if(empty, "clean", "dirty")')" != clean ]]; then
    echo "error: working copy (@) has changes — commit or abandon them first" >&2
    exit 1
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    echo "error: tag $TAG already exists" >&2
    exit 1
fi
# The Unreleased section must have content — the notes humans will read.
NOTES=$(awk '/^## \[Unreleased\]/{grab=1; next} /^## \[/{grab=0} grab' CHANGELOG.md)
if [[ -z "${NOTES//[[:space:]]/}" ]]; then
    echo "error: CHANGELOG.md has an empty Unreleased section — nothing to release" >&2
    exit 1
fi

PREV=$(jq -r .version package.json)
DATE=$(date +%F)

# --- Stamp version + changelog, commit, bookmark, tag ---------------------

jq --arg v "$VERSION" '.version = $v' package.json >package.json.tmp
mv package.json.tmp package.json
bunx prettier --write package.json >/dev/null

# New release heading right below Unreleased, so its content moves under the
# new version; refresh the compare links at the bottom.
sed -i "s|^## \[Unreleased\]$|## [Unreleased]\n\n## [$VERSION] - $DATE|" CHANGELOG.md
sed -i "s|^\[Unreleased\]: .*|[Unreleased]: https://github.com/$GITHUB_REPO/compare/$TAG...HEAD\n[$VERSION]: https://github.com/$GITHUB_REPO/compare/v$PREV...$TAG|" CHANGELOG.md

jj commit -m "Release $VERSION"
jj bookmark set main -r @-
RELEASE_COMMIT=$(jj log --no-graph -r @- -T commit_id)
# Annotated tags need a committer identity, which lives in jj's config here.
git -c user.name="$(jj config get user.name)" \
    -c user.email="$(jj config get user.email)" \
    tag -a "$TAG" -m "Turbo Jumbo $VERSION" "$RELEASE_COMMIT"
echo "Tagged $TAG at ${RELEASE_COMMIT:0:12}"

# --- Push branch + tag to both remotes ------------------------------------

for remote in origin github; do
    jj git push --remote "$remote" --bookmark main
    git push "$remote" "$TAG"
done

# --- Publish release notes ------------------------------------------------

NOTES_FILE=$(mktemp)
trap 'rm -f "$NOTES_FILE"' EXIT
printf '%s\n' "$NOTES" | sed -e '1{/^$/d}' >"$NOTES_FILE"

publish() { # name, url, auth-header, token
    local name=$1 url=$2 auth=$3 token=$4
    if [[ -z "$token" ]]; then
        echo "note: no ${name} token — create the $TAG release by hand from CHANGELOG.md" >&2
        return
    fi
    jq -n --arg tag "$TAG" --arg name "Turbo Jumbo $VERSION" \
        --rawfile body "$NOTES_FILE" \
        '{tag_name: $tag, name: $name, body: $body}' |
        curl -sf -X POST "$url" -H "Authorization: $auth $token" \
            -H 'Content-Type: application/json' -d @- >/dev/null &&
        echo "Published the $name release for $TAG" ||
        echo "warning: creating the $name release failed — do it by hand from CHANGELOG.md" >&2
}

publish GitHub "https://api.github.com/repos/$GITHUB_REPO/releases" \
    Bearer "${GITHUB_TOKEN:-}"

# The Forgejo API base: FORGEJO_URL overrides; otherwise take the host from
# the origin remote and probe which scheme its API answers on.
FORGEJO_HOST=$(remote_host origin)
if [[ -z "${FORGEJO_URL:-}" ]]; then
    for scheme in https http; do
        if curl -sf -o /dev/null --connect-timeout 5 \
            "$scheme://$FORGEJO_HOST/api/v1/version"; then
            FORGEJO_URL=$scheme://$FORGEJO_HOST
            break
        fi
    done
fi
if [[ -n "${FORGEJO_URL:-}" ]]; then
    publish Forgejo "$FORGEJO_URL/api/v1/repos/$(repo_path origin)/releases" \
        token "${FORGEJO_TOKEN:-}"
else
    echo "warning: no reachable Forgejo API (set FORGEJO_URL) — create the $TAG release by hand" >&2
fi

echo "Released Turbo Jumbo $VERSION"
