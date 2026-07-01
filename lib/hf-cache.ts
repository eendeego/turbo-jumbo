// The huggingface_hub cache layout: a repo's files live under
// `models--<org>--<repo>/snapshots/<commit>/<repoPath>` (the snapshot files are
// symlinks into a sibling `blobs/` store). Models downloaded through `hf` /
// Lemonade land here, so the scanner and audit recognize it as an alternative
// to the flat `<org>/<repo>/<repoPath>` mirror.

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Decode a storage-root-relative path in the huggingface_hub cache layout into
 * its repo id, snapshot revision, and in-repo path. Returns null when the path
 * isn't a cache snapshot file: the `models--…` directory must be the first
 * segment (so a path is only recognized when the storage root *is* the cache
 * root), `snapshots/<rev>/` must follow, an in-repo path must remain, and the
 * decoded directory name must be a valid `org/repo` id. The `--` → `/` decode
 * is huggingface_hub's own convention; repo names containing `--` decode to
 * extra slashes and are (rarely, safely) rejected.
 */
export function parseHubCachePath(
  relPath: string,
): {repoId: string; rev: string; repoPath: string} | null {
  const segments = relPath.split('/');
  if (segments.length < 4) return null;
  const [dir, kind, rev, ...rest] = segments;
  if (!dir.startsWith('models--') || kind !== 'snapshots') return null;
  if (!rev || rest.length === 0) return null;
  const repoId = dir.slice('models--'.length).replaceAll('--', '/');
  if (!REPO_ID_RE.test(repoId)) return null;
  return {repoId, rev, repoPath: rest.join('/')};
}
