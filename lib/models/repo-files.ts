import {
  readFileMetaByPath,
  fileProvenance,
  modelFileScope,
  modelRevision,
} from '@/lib/models/model-sidecar';
import type {FileProvenance} from '@/lib/models/sidecar-types';
import {isPickOneBinRepo, isPickOneSafetensorsRepo} from '@/lib/hf/hf-download';
import {isDiffusersRepo} from '@/lib/models/diffusers';
import {isClutterFile} from '@/lib/models/repo-clutter';
import {existsSync, statSync} from 'fs';
import nodePath from 'path';

export type RepoFileState = 'present' | 'missing' | 'invalid';

export interface RepoFile {
  path: string; // repo-relative path
  state: RepoFileState;
  size: number | null; // local size, null when missing
  expectedSize: number; // size on Hugging Face
  // The file's sidecar provenance, when the download recorded one (present
  // on-disk files only). Absent for missing files and unrecorded files.
  provenance?: FileProvenance;
}

// The repo tree changes rarely; cache it per repo and revision. The on-disk
// comparison below is recomputed every call so a fresh download flips a file
// present.
const TTL_MS = 30 * 60 * 1000;
interface TreeFile {
  path: string;
  size: number;
}
const treeCache = new Map<string, {files: TreeFile[]; fetchedAt: number}>();

async function repoTree(repoId: string, revision: string): Promise<TreeFile[]> {
  const key = `${repoId}@${revision}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.files;
  const res = await fetch(
    `https://huggingface.co/api/models/${repoId}/tree/${revision}?recursive=true`,
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
  treeCache.set(key, {files, fetchedAt: Date.now()});
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
 *
 * A pick-one `.bin` repo (ggml whisper.cpp-style, see `isPickOneBinRepo`) is
 * treated like GGUF: only files present on disk are reported, never the repo's
 * other un-downloaded variants as `missing`.
 */
export async function repoFileStatuses(
  storageBase: string,
  repoId: string,
): Promise<RepoFile[]> {
  const base = nodePath.resolve(storageBase);
  // Judge against the revision the model tracks (its sidecar pin), not
  // whatever main looks like today — a pinned repo's main may carry different
  // files entirely.
  const revision = await modelRevision(base, repoId);
  // A file-scoped model (a FastFlowLM registry pin) is judged only against
  // the files that make a complete copy of it — the repo's extra files (NPU
  // kernels) aren't part of the model, so they're neither listed nor missing.
  const scope = await modelFileScope(base, repoId);
  // Drop repo clutter (`.gitattributes`, docs, images): never a required file,
  // so never reported as missing.
  const tree = (await repoTree(repoId, revision)).filter(
    (f) => !isClutterFile(f.path) && (scope == null || scope.has(f.path)),
  );
  const dir = nodePath.join(base, repoId);
  const paths = tree.map((f) => f.path);
  // A pick-one repo — ggml whisper.cpp-style `.bin` weights, a Comfy-Org
  // split_files safetensors bundle, or a diffusers pipeline (component folders
  // at two precisions) — holds independent models/components; like GGUF, an
  // un-downloaded variant isn't "missing", so report only the files present on
  // disk, not the whole repo.
  const pickOne =
    isPickOneBinRepo(paths) ||
    isPickOneSafetensorsRepo(paths) ||
    isDiffusersRepo(paths);
  const out: RepoFile[] = [];
  for (const f of tree) {
    const full = nodePath.join(dir, f.path);
    if (!existsSync(full)) {
      if (pickOne) continue;
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
    // For a file present on disk, the sidecar (when the download recorded one)
    // both validates the copy and supplies the row's provenance.
    const meta = await readFileMetaByPath(base, `${repoId}/${f.path}`);
    if (state === 'present' && meta) {
      // The size matches HF. Validate by size alone unless the sidecar can prove
      // a problem from what the download recorded: a computed size that disagrees
      // with a known source size, or disagreeing hashes (truncated or corrupted
      // at download). An unknown source size — a checksum-less file HF serves no
      // way to attest — is left valid on the size match above, not flagged.
      if (
        (meta.sourceSize > 0 &&
          meta.computedSize > 0 &&
          meta.computedSize !== meta.sourceSize) ||
        (!!meta.sourceSha256 &&
          !!meta.computedSha256 &&
          meta.sourceSha256 !== meta.computedSha256)
      ) {
        state = 'invalid';
      }
    }
    out.push({
      path: f.path,
      state,
      size,
      expectedSize: f.size,
      ...(meta ? {provenance: fileProvenance(meta)} : {}),
    });
  }
  return out;
}
