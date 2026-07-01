export interface HfFileInfo {
  repoId: string;
  branch: string;
  repoPath: string; // path of the file within the repo
  commit: string; // resolved commit SHA the branch/tag pointed at (immutable), '' if unknown
  commitDate: string; // ISO 8601 timestamp of that commit, '' if unknown
  size: number;
  sha256: string; // hex, no "sha256:" prefix
}

interface HfSearchEntry {
  id: string;
}

interface HfTreeEntry {
  type: string;
  path: string;
  size: number;
  lfs?: {oid: string; size: number};
}

const HEADERS = {'User-Agent': 'tj/1.0'};
const cache = new Map<string, HfFileInfo | null>();

/** Reset the inference cache. Call once at the start of each audit run so a
 *  transient HF outage doesn't pin a file to `unverifiable` for the process life. */
export function clearHfCache(): void {
  cache.clear();
}

export async function inferHfFile(
  modelName: string,
  filename: string,
  branch = 'main',
): Promise<HfFileInfo | null> {
  const key = `${modelName}${filename}${branch}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const result = await resolveHfFile(modelName, filename, branch);
  cache.set(key, result);
  return result;
}

// Convert a repo-tree entry into file info, or null if it carries no Git-LFS
// checksum. The sha256 is the LFS object id; a match without one (a small,
// non-LFS file) can't be verified, so callers skip it rather than return an
// empty sha that reads as corruption.
function treeEntryToInfo(
  repoId: string,
  branch: string,
  commit: string,
  commitDate: string,
  entry: HfTreeEntry,
): HfFileInfo | null {
  const oid = entry.lfs?.oid ?? '';
  const sha256 = oid.startsWith('sha256:') ? oid.slice('sha256:'.length) : oid;
  if (!sha256) return null;
  return {
    repoId,
    branch,
    repoPath: entry.path,
    commit,
    commitDate,
    size: entry.lfs?.size ?? entry.size,
    sha256,
  };
}

// Resolve the commit a branch/tag currently points at (its SHA and timestamp),
// so a verified file can be pinned to an immutable revision even when it was
// fetched from a moving ref like `main`. SHA/date degrade to '' if the revision
// can't be resolved — callers must treat them as best-effort, never required.
async function fetchRepoCommit(
  repoId: string,
  branch: string,
): Promise<{commit: string; commitDate: string}> {
  try {
    const res = await fetch(
      `https://huggingface.co/api/models/${repoId}/revision/${branch}`,
      {headers: HEADERS},
    );
    if (!res.ok) return {commit: '', commitDate: ''};
    const data = (await res.json()) as {sha?: string; lastModified?: string};
    return {commit: data.sha ?? '', commitDate: data.lastModified ?? ''};
  } catch {
    return {commit: '', commitDate: ''};
  }
}

// Fetch a repo's file tree. repoId/branch are interpolated into the URL raw, so
// callers must validate them (search results and parseHfFileUrl both do).
async function fetchTree(
  repoId: string,
  branch: string,
): Promise<HfTreeEntry[] | null> {
  let res: Response;
  try {
    res = await fetch(
      `https://huggingface.co/api/models/${repoId}/tree/${branch}?recursive=true&expand=true`,
      {headers: HEADERS},
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return (await res.json()) as HfTreeEntry[];
}

async function resolveHfFile(
  modelName: string,
  filename: string,
  branch: string,
): Promise<HfFileInfo | null> {
  let searchRes: Response;
  try {
    searchRes = await fetch(
      `https://huggingface.co/api/models?search=${encodeURIComponent(
        modelName,
      )}&filter=gguf&limit=10`,
      {headers: HEADERS},
    );
  } catch {
    return null;
  }
  if (!searchRes.ok) return null;
  const candidates = (await searchRes.json()) as HfSearchEntry[];

  for (const candidate of candidates) {
    const entries = await fetchTree(candidate.id, branch);
    if (!entries) continue;
    const match = entries.find(
      (e) => e.type === 'file' && e.path.split('/').pop() === filename,
    );
    if (!match) continue;
    const {commit, commitDate} = await fetchRepoCommit(candidate.id, branch);
    const info = treeEntryToInfo(
      candidate.id,
      branch,
      commit,
      commitDate,
      match,
    );
    if (!info) continue; // matched by name but no checksum — keep looking
    return info;
  }
  return null;
}

export interface HfFileRef {
  repoId: string;
  branch: string;
  repoPath: string; // path of the file within the repo
}

// A HuggingFace file URL: https://huggingface.co/<org>/<repo>/(blob|resolve)/<branch>/<repoPath>.
// Branches with slashes (e.g. refs/pr/1) aren't supported — the common case is a
// plain branch/tag, and allowing slashes would make repoPath ambiguous.
const HF_FILE_URL_RE =
  /^https?:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:blob|resolve)\/([A-Za-z0-9_.-]+)\/(.+)$/;

/**
 * Parse a HuggingFace file URL (blob or resolve form) into its repo, branch and
 * in-repo path. Returns null if it isn't a well-formed huggingface.co file URL.
 * Strips any query/hash and rejects paths that try to escape with `..`.
 */
export function parseHfFileUrl(url: string): HfFileRef | null {
  const m = url.trim().match(HF_FILE_URL_RE);
  if (!m) return null;
  const [, repoId, branch, rawPath] = m;
  const repoPath = rawPath.replace(/[?#].*$/, '');
  if (!repoPath || repoPath.split('/').includes('..')) return null;
  return {repoId, branch, repoPath};
}

/**
 * Resolve a file's size and checksum from a known repo path, without the name
 * search `inferHfFile` does. Used when the source is supplied explicitly (e.g. a
 * pasted URL) so files whose folder name doesn't match their repo can still be
 * verified. Returns null if the repo/path can't be reached or carries no LFS sha.
 */
export async function resolveHfFileByPath(
  repoId: string,
  branch: string,
  repoPath: string,
): Promise<HfFileInfo | null> {
  const entries = await fetchTree(repoId, branch);
  if (!entries) return null;
  const match = entries.find((e) => e.type === 'file' && e.path === repoPath);
  if (!match) return null;
  const {commit, commitDate} = await fetchRepoCommit(repoId, branch);
  return treeEntryToInfo(repoId, branch, commit, commitDate, match);
}
