import {logger} from '@/lib/logger';

export interface HfFileInfo {
  repoId: string;
  branch: string;
  repoPath: string; // path of the file within the repo
  commit: string; // commit that last modified this file (what the HF file page shows), '' if unknown
  commitDate: string; // ISO 8601 date of that commit, '' if unknown
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
  // Present with `expand=true`: the commit that last touched this path — the
  // file-level revision the HF blob page shows (not the repo HEAD).
  lastCommit?: {id: string; date: string};
}

const HEADERS = {'User-Agent': 'tj/1.0'};
const cache = new Map<string, HfFileInfo | null>();
const commitsCache = new Map<string, HfCommitRef[] | null>();
const revisionCache = new Map<string, HfFileInfo | null>();
const treeCache = new Map<string, HfTreeEntry[] | null>();
const headCache = new Map<string, HfCommitRef | null>();

// How many search results to consider. Ranking drifts as newer model families
// flood the index (e.g. LFM2.5 pushed unsloth/LFM2-1.2B-GGUF to rank ~13), so
// the window is effectively unbounded — the API caps it at the full result
// set. Candidates are tried in order and the loop stops at the first match,
// so a deep window only costs requests when nothing near the top matches.
const SEARCH_LIMIT = 500;

/** Reset the inference caches. Call once at the start of each audit run so a
 *  transient HF outage doesn't pin a file to `unverifiable` for the process life. */
export function clearHfCache(): void {
  cache.clear();
  commitsCache.clear();
  revisionCache.clear();
  treeCache.clear();
  headCache.clear();
}

export async function inferHfFile(
  modelName: string,
  filename: string,
  branch = 'main',
): Promise<HfFileInfo | null> {
  const key = `${modelName}\0${filename}\0${branch}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const result = await resolveHfFile(modelName, filename, branch);
  cache.set(key, result);
  return result;
}

// Convert a repo-tree entry into file info, or null if it carries no Git-LFS
// checksum. The sha256 is the LFS object id; a match without one (a small,
// non-LFS file) can't be verified, so callers skip it rather than return an
// empty sha that reads as corruption. The commit/date come from the entry's
// `lastCommit` (the file's own last-modifying commit, matching the HF blob
// page) — not the repo HEAD — and are best-effort: empty when absent.
function treeEntryToInfo(
  repoId: string,
  branch: string,
  entry: HfTreeEntry,
): HfFileInfo | null {
  const oid = entry.lfs?.oid ?? '';
  const sha256 = oid.startsWith('sha256:') ? oid.slice('sha256:'.length) : oid;
  if (!sha256) return null;
  return {
    repoId,
    branch,
    repoPath: entry.path,
    commit: entry.lastCommit?.id ?? '',
    commitDate: entry.lastCommit?.date ?? '',
    size: entry.lfs?.size ?? entry.size,
    sha256,
  };
}

// Hard ceiling on tree-listing pagination (~50 entries per page), so a
// pathological repo can't turn one resolution into hundreds of requests.
const MAX_TREE_PAGES = 40;

// Fetch a repo's file tree, cached per repo+branch for the run — auditing many
// files of one model resolves against the same tree. The endpoint paginates
// (~50 entries per page); follow the Link headers through the whole listing,
// or a repo's 51st-and-later files are invisible and audit as unverifiable. A
// page failure mid-walk keeps the entries gathered so far — a truncated tree
// still resolves the files it lists. repoId/branch are interpolated into the
// URL raw, so callers must validate them (search results, parseHfFileUrl and
// pathImpliedRepo all do).
async function fetchTree(
  repoId: string,
  branch: string,
): Promise<HfTreeEntry[] | null> {
  const key = `${repoId} ${branch}`;
  const cached = treeCache.get(key);
  if (cached !== undefined) return cached;
  let result: HfTreeEntry[] | null = null;
  let url: string | null =
    `https://huggingface.co/api/models/${repoId}/tree/${branch}?recursive=true&expand=true`;
  for (let page = 0; url && page < MAX_TREE_PAGES; page++) {
    try {
      const res = await fetch(url, {headers: HEADERS});
      if (!res.ok) {
        logger.debug(`[hf] tree ${repoId}@${branch}: HTTP ${res.status}`);
        break;
      }
      const entries = (await res.json()) as HfTreeEntry[];
      result = result ? result.concat(entries) : entries;
      url = nextPageUrl(res.headers.get('link'));
    } catch (e) {
      // A thrown error (network fault, non-JSON body) is not the same as a
      // clean 404 — surface it so a truncated/empty tree isn't a silent mystery.
      logger.debug(`[hf] tree ${repoId}@${branch} fetch failed:`, e);
      break;
    }
  }
  treeCache.set(key, result);
  return result;
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
      )}&filter=gguf&limit=${SEARCH_LIMIT}`,
      {headers: HEADERS},
    );
  } catch (e) {
    logger.debug(`[hf] search "${modelName}" fetch failed:`, e);
    return null;
  }
  if (!searchRes.ok) {
    logger.debug(`[hf] search "${modelName}": HTTP ${searchRes.status}`);
    return null;
  }
  const candidates = (await searchRes.json()) as HfSearchEntry[];

  for (const candidate of candidates) {
    const entries = await fetchTree(candidate.id, branch);
    if (!entries) continue;
    const match = entries.find(
      (e) => e.type === 'file' && e.path.split('/').pop() === filename,
    );
    if (!match) continue;
    const info = treeEntryToInfo(candidate.id, branch, match);
    if (!info) continue; // matched by name but no checksum — keep looking
    return info;
  }
  return null;
}

/**
 * The branch to audit against for a URL's branch-or-revision segment. A commit
 * permalink (a full 40-hex SHA) pins the repo to one moment; resolving "latest"
 * there hides every newer revision, so a pin canonicalizes to `main`. Anything
 * shorter could be a real branch or tag name and passes through unchanged. An
 * older on-disk file still passes audit: the history walk finds its revision
 * from the branch head.
 */
export function canonicalBranch(branch: string): string {
  return /^[0-9a-f]{40}$/i.test(branch) ? 'main' : branch;
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
  return treeEntryToInfo(repoId, branch, match);
}

/**
 * Every file in a repo at a branch as resolved HfFileInfo, or null on fetch
 * failure. Reuses the run's tree cache. Entries without a checksum (non-LFS
 * files) are dropped, like treeEntryToInfo does elsewhere.
 */
export async function listRepoFiles(
  repoId: string,
  branch: string,
): Promise<HfFileInfo[] | null> {
  const entries = await fetchTree(repoId, branch);
  if (!entries) return null;
  return entries
    .filter((e) => e.type === 'file')
    .map((e) => treeEntryToInfo(repoId, branch, e))
    .filter((i): i is HfFileInfo => i != null);
}

export interface HfCommitRef {
  id: string; // commit SHA
  date: string; // ISO 8601, '' if absent
}

// Hard ceiling on commit-listing pagination (~50 commits per page), so a
// pathological repo can't turn one audit into thousands of requests.
const MAX_COMMIT_PAGES = 40;

/** The rel="next" target of a Link response header, or null when on the last
 *  page (or the header is absent/unparseable). */
function nextPageUrl(linkHeader: string | null): string | null {
  const m = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

/**
 * List a repo's commits on a branch, newest first — what the HF "commits" page
 * shows. Follows the API's pagination through the full history (capped at
 * MAX_COMMIT_PAGES). Returns null when the repo/branch can't be reached at
 * all; a page failure mid-walk returns the commits gathered so far, since a
 * truncated history is still useful to search.
 */
export async function listHfCommits(
  repoId: string,
  branch: string,
): Promise<HfCommitRef[] | null> {
  const key = `${repoId} ${branch}`;
  const cached = commitsCache.get(key);
  if (cached !== undefined) return cached;
  let result: HfCommitRef[] | null = null;
  let url: string | null =
    `https://huggingface.co/api/models/${repoId}/commits/${branch}`;
  for (let page = 0; url && page < MAX_COMMIT_PAGES; page++) {
    try {
      const res = await fetch(url, {headers: HEADERS});
      if (!res.ok) {
        logger.debug(`[hf] commits ${repoId}@${branch}: HTTP ${res.status}`);
        break;
      }
      const commits = (await res.json()) as Array<{id: string; date?: string}>;
      const refs = commits.map((c) => ({id: c.id, date: c.date ?? ''}));
      result = result ? result.concat(refs) : refs;
      url = nextPageUrl(res.headers.get('link'));
    } catch (e) {
      logger.debug(`[hf] commits ${repoId}@${branch} fetch failed:`, e);
      break;
    }
  }
  commitsCache.set(key, result);
  return result;
}

/**
 * Resolve a branch's HEAD commit — the repo revision HuggingFace's cache names
 * its `snapshots/<rev>/` directory after (and what `git ls-remote … <branch>`
 * returns), as opposed to the file-level `lastCommit` the tree listing carries.
 * One lightweight request to the revision-info endpoint, cached per repo+branch
 * for the run. Returns null when the repo/branch can't be reached.
 */
export async function resolveHfHead(
  repoId: string,
  branch: string,
): Promise<HfCommitRef | null> {
  const key = `${repoId} ${branch}`;
  const cached = headCache.get(key);
  if (cached !== undefined) return cached;
  let result: HfCommitRef | null = null;
  try {
    const res = await fetch(
      `https://huggingface.co/api/models/${repoId}/revision/${branch}`,
      {headers: HEADERS},
    );
    if (res.ok) {
      const info = (await res.json()) as {sha?: string; lastModified?: string};
      if (info.sha) result = {id: info.sha, date: info.lastModified ?? ''};
    } else {
      logger.debug(`[hf] head ${repoId}@${branch}: HTTP ${res.status}`);
    }
  } catch (e) {
    logger.debug(`[hf] head ${repoId}@${branch} fetch failed:`, e);
    result = null;
  }
  headCache.set(key, result);
  return result;
}

/**
 * Resolve a file's size and checksum as of a specific revision (a commit SHA),
 * via the paths-info endpoint — much lighter than fetching the whole recursive
 * tree per revision. `branch` is only carried into the returned info for URL
 * construction; `revision` determines what is inspected. Returns null when the
 * file doesn't exist at that revision or carries no LFS sha.
 */
export async function resolveHfFileAtRevision(
  repoId: string,
  branch: string,
  revision: string,
  repoPath: string,
): Promise<HfFileInfo | null> {
  const key = `${repoId} ${revision} ${repoPath}`;
  const cached = revisionCache.get(key);
  if (cached !== undefined) return cached;
  let result: HfFileInfo | null = null;
  try {
    const res = await fetch(
      `https://huggingface.co/api/models/${repoId}/paths-info/${revision}`,
      {
        method: 'POST',
        headers: {...HEADERS, 'Content-Type': 'application/json'},
        body: JSON.stringify({paths: [repoPath], expand: true}),
      },
    );
    if (res.ok) {
      const entries = (await res.json()) as HfTreeEntry[];
      const match = entries.find(
        (e) => e.type === 'file' && e.path === repoPath,
      );
      result = match ? treeEntryToInfo(repoId, branch, match) : null;
    } else {
      logger.debug(
        `[hf] paths-info ${repoId}@${revision} ${repoPath}: HTTP ${res.status}`,
      );
    }
  } catch (e) {
    logger.debug(
      `[hf] paths-info ${repoId}@${revision} ${repoPath} fetch failed:`,
      e,
    );
    result = null;
  }
  revisionCache.set(key, result);
  return result;
}
