import {parseHubCachePath} from '@/lib/hf/hf-cache';
import type {HfFileInfo} from '@/lib/hf/hf-infer';
import type {
  AuditResult,
  AuditStatus,
  HfSummary,
  TjMeta,
  UpdateResult,
} from '@/lib/audit/audit';

/**
 * Compare a file's recorded source commit against the repo's current head
 * commit for that file. `unknown` when either is missing (a legacy sidecar with
 * no commit, or HF couldn't be reached); `current` when they match; `update`
 * when they differ. Pure — the I/O lives in `auditFileUpdate`.
 */
export function decideUpdate(
  recordedCommit: string,
  headCommit: string,
): UpdateResult['status'] {
  if (!recordedCommit || !headCommit) return 'unknown';
  return recordedCommit === headCommit ? 'current' : 'update';
}

/**
 * Where a file should live relative to the storage root: the HuggingFace
 * layout mirrored on disk, i.e. `<repoId>/<repoPath>` (e.g.
 * `unsloth/FLUX.2-klein-9B-GGUF/flux-2-klein-9b-Q8_0.gguf`). `repoPath` alone
 * is only the path *within* the repo, so a file dropped at the storage root
 * must not be treated as correctly placed.
 */
export function expectedRelPath(hf: HfFileInfo): string {
  return `${hf.repoId}/${hf.repoPath}`;
}

/**
 * Whether a file is stored where its source says it belongs. True for the flat
 * mirror (`<repoId>/<repoPath>`) and for the huggingface_hub cache layout
 * (`models--…/snapshots/<rev>/<repoPath>` of the same repo). Anything else —
 * a bare file at the root, the wrong repo directory — is misplaced.
 */
export function isPlacedCorrectly(
  relPath: string,
  repoId: string,
  repoPath: string,
): boolean {
  if (relPath === `${repoId}/${repoPath}`) return true;
  const cache = parseHubCachePath(relPath);
  return (
    cache != null && cache.repoId === repoId && cache.repoPath === repoPath
  );
}

// One path segment of an HF repo id (org or repo name).
const REPO_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * The HF repo a file's on-disk placement implies. Storage mirrors HuggingFace
 * as `<org>/<repo>/<repoPath>` (see `expectedRelPath`), so a path with at
 * least three segments names a candidate repo to resolve against directly.
 * Null for files not under an `<org>/<repo>/` directory or whose segments
 * aren't valid HF ids.
 */
export function pathImpliedRepo(
  relPath: string,
): {repoId: string; repoPath: string} | null {
  const segments = relPath.split('/');
  if (segments.length < 3) return null;
  const [org, repo] = segments;
  if (!REPO_SEGMENT_RE.test(org) || !REPO_SEGMENT_RE.test(repo)) return null;
  return {repoId: `${org}/${repo}`, repoPath: segments.slice(2).join('/')};
}

export function hfSummary(hf: HfFileInfo): HfSummary {
  return {
    repoId: hf.repoId,
    modelUrl: `https://huggingface.co/${hf.repoId}`,
    fileUrl: `https://huggingface.co/${hf.repoId}/blob/${hf.branch}/${hf.repoPath}`,
    ...(hf.commit
      ? {
          commit: hf.commit,
          commitUrl: `https://huggingface.co/${hf.repoId}/blob/${hf.commit}/${hf.repoPath}`,
          ...(hf.commitDate ? {commitDate: hf.commitDate} : {}),
        }
      : {}),
    expectedSize: hf.size,
    expectedSha256: hf.sha256,
    expectedPath: expectedRelPath(hf),
  };
}

/**
 * Reconstruct a best-effort verdict from a previously written sidecar, without
 * re-hashing or hitting the network. The sidecar records the source size for
 * display, but a sidecar only exists once the size already matched (auditFile
 * bails before writing it otherwise), so the size check itself is not re-run:
 * only the cached sha comparison and the current placement are evaluated. Marked
 * `cached` so the UI can tone it down against a fresh result.
 */
export function cachedResultFromMeta(
  relPath: string,
  meta: TjMeta,
  actualSize?: number,
): AuditResult {
  const repoId = meta.modelUrl.replace(/^https:\/\/huggingface\.co\//, '');
  const pathMatch = meta.originUrl.match(
    /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/,
  );
  const repoPath = pathMatch?.[1] ?? '';
  const hf: HfSummary | undefined =
    repoId && repoPath
      ? {
          repoId,
          modelUrl: meta.modelUrl,
          fileUrl: meta.originUrl,
          ...(meta.sourceCommit
            ? {
                commit: meta.sourceCommit,
                commitUrl: `https://huggingface.co/${repoId}/blob/${meta.sourceCommit}/${repoPath}`,
                ...(meta.sourceCommitDate
                  ? {commitDate: meta.sourceCommitDate}
                  : {}),
              }
            : {}),
          ...(typeof meta.sourceSize === 'number'
            ? {expectedSize: meta.sourceSize}
            : {}),
          expectedSha256: meta.sourceSha256,
          expectedPath: `${repoId}/${repoPath}`,
        }
      : undefined;

  // The file's size as the sidecar last observed it (`computedSize`) — but the
  // caller's live on-disk size wins when supplied. A sidecar out-lives the file
  // it describes: a cold-storage copy writes no sidecar, so an interrupted
  // re-copy can truncate a file that was complete when last audited, leaving a
  // passing record over an incomplete file. Trusting the recorded size would
  // then report a stale `pass`, so the size check is against what's on disk now.
  const observedSize = actualSize ?? meta.computedSize;
  // When the live size disagrees with what was hashed, the file changed since
  // the sidecar was written, so the recorded checksum no longer attests it.
  const sizeChanged =
    actualSize != null &&
    typeof meta.computedSize === 'number' &&
    actualSize !== meta.computedSize;

  let status: AuditStatus;
  let message: string | undefined;
  if (meta.missing) {
    // Recorded by a prior audit as expected-on-HF but absent on disk.
    status = 'incomplete';
    message = 'expected file not downloaded';
  } else if (!meta.sourceSha256) {
    status = 'unverifiable';
  } else if (
    typeof observedSize === 'number' &&
    meta.sourceSize > 0 &&
    observedSize !== meta.sourceSize
  ) {
    status = 'incomplete';
    message = `size ${observedSize} != expected ${meta.sourceSize}`;
  } else if (sizeChanged) {
    // Size matches the source but differs from what was hashed: a re-audit must
    // recompute the checksum before the file can be attested again.
    status = 'unverifiable';
    message = 'changed since last audit';
  } else if (!meta.computedSha256) {
    // An interrupted audit records the source before hashing — the comparison
    // never happened, which is not a mismatch.
    status = 'unverifiable';
    message = 'not hashed';
  } else if (meta.computedSha256 !== meta.sourceSha256) {
    status = 'checksum-mismatch';
  } else if (hf && !isPlacedCorrectly(relPath, repoId, repoPath)) {
    status = 'misplaced';
    message = `expected path ${hf.expectedPath}`;
  } else {
    status = 'pass';
  }

  return {
    file: relPath,
    status,
    ...(message ? {message} : {}),
    hf,
    cached: true,
  };
}

/**
 * Fast-fail verdict for a file whose basename collides with other files in the
 * same location (see `duplicateBasenames`). Duplication wins over content
 * checks — the file is never resolved or hashed — so the message names the
 * other copies for the user to resolve via the delete flow.
 */
export function duplicateResult(
  relPath: string,
  allPaths: string[],
  cached = false,
): AuditResult {
  const others = allPaths.filter((p) => p !== relPath);
  return {
    file: relPath,
    status: 'duplicate',
    message: `duplicate of ${others.join(', ')}`,
    ...(cached ? {cached: true} : {}),
  };
}

/**
 * Pure verdict. Order matches the spec: size (fail-fast) -> sha256 -> directory.
 * `computedSha256` is null only when hashing failed after the size matched.
 */
export function decideStatus(input: {
  hf: HfFileInfo | null;
  actualSize: number;
  relPath: string;
  computedSha256: string | null;
}): AuditStatus {
  const {hf, actualSize, relPath, computedSha256} = input;
  if (!hf) return 'unverifiable';
  if (actualSize !== hf.size) return 'incomplete';
  if (computedSha256 === null) return 'error';
  if (computedSha256 !== hf.sha256) return 'checksum-mismatch';
  if (!isPlacedCorrectly(relPath, hf.repoId, hf.repoPath)) return 'misplaced';
  return 'pass';
}
