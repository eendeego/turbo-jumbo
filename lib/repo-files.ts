import {readFileMetaByPath} from '@/lib/model-sidecar';
import {existsSync, statSync} from 'fs';
import nodePath from 'path';

export type RepoFileState = 'present' | 'missing' | 'invalid';

export interface RepoFile {
  path: string; // repo-relative path
  state: RepoFileState;
  size: number | null; // local size, null when missing
  expectedSize: number; // size on Hugging Face
}

// The repo tree changes rarely; cache it per repo. The on-disk comparison below
// is recomputed every call so a fresh download flips a file present.
const TTL_MS = 30 * 60 * 1000;
interface TreeFile {
  path: string;
  size: number;
}
const treeCache = new Map<string, {files: TreeFile[]; fetchedAt: number}>();

async function repoTree(repoId: string): Promise<TreeFile[]> {
  const hit = treeCache.get(repoId);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.files;
  const res = await fetch(
    `https://huggingface.co/api/models/${repoId}/tree/main?recursive=true`,
    {headers: {'User-Agent': 'tj/1.0'}},
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const entries = (await res.json()) as Array<{
    type: string;
    path: string;
    size: number;
    lfs?: {size: number};
  }>;
  const files = entries
    .filter((e) => e.type === 'file')
    .map((e) => ({path: e.path, size: e.lfs?.size ?? e.size}));
  treeCache.set(repoId, {files, fetchedAt: Date.now()});
  return files;
}

/**
 * Every file in `repoId`'s HF tree, each judged against the local copy under
 * `storageBase/<repoId>`: `missing` (not on disk), `invalid`, else `present`.
 * Files are validated by size against the HF tree; a file HF serves a checksum
 * for is additionally invalid when its sidecar's recorded hash/size disagree
 * with the source. A checksum-less file (no LFS oid, e.g. index.json) is judged
 * by size alone — a size match is valid even though it can't be attested. No
 * live hashing — only the file size and any sidecar the download recorded.
 */
export async function repoFileStatuses(
  storageBase: string,
  repoId: string,
): Promise<RepoFile[]> {
  const base = nodePath.resolve(storageBase);
  const tree = await repoTree(repoId);
  const dir = nodePath.join(base, repoId);
  const out: RepoFile[] = [];
  for (const f of tree) {
    const full = nodePath.join(dir, f.path);
    if (!existsSync(full)) {
      out.push({
        path: f.path,
        state: 'missing',
        size: null,
        expectedSize: f.size,
      });
      continue;
    }
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      /* unreadable: treated as size 0 below */
    }
    let state: RepoFileState = size === f.size ? 'present' : 'invalid';
    if (state === 'present') {
      // The size matches HF. Validate by size alone unless the sidecar can prove
      // a problem from what the download recorded: a computed size that disagrees
      // with a known source size, or disagreeing hashes (truncated or corrupted
      // at download). An unknown source size — a checksum-less file HF serves no
      // way to attest — is left valid on the size match above, not flagged.
      const meta = await readFileMetaByPath(base, `${repoId}/${f.path}`);
      if (
        meta &&
        ((meta.sourceSize > 0 &&
          meta.computedSize > 0 &&
          meta.computedSize !== meta.sourceSize) ||
          (!!meta.sourceSha256 &&
            !!meta.computedSha256 &&
            meta.sourceSha256 !== meta.computedSha256))
      ) {
        state = 'invalid';
      }
    }
    out.push({path: f.path, state, size, expectedSize: f.size});
  }
  return out;
}
