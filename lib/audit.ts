import {createHash} from 'crypto';
import {createReadStream, createWriteStream, promises as fsp} from 'fs';
import path from 'path';
import {pipeline} from 'stream/promises';
import {parseHubCachePath} from '@/lib/hf-cache';
import {
  canonicalBranch,
  inferHfFile,
  listHfCommits,
  parseHfFileUrl,
  resolveHfFileAtRevision,
  resolveHfFileByPath,
  type HfFileInfo,
} from '@/lib/hf-infer';
import {repoIdFromModelUrl} from '@/lib/model-name';
import {
  metaToEntry,
  modelDirForRepo,
  readFileMetaByPath,
  removeFileMeta,
  upsertFileMeta,
} from '@/lib/model-sidecar';

export type AuditStatus =
  | 'pass'
  | 'incomplete'
  | 'checksum-mismatch'
  | 'misplaced'
  | 'duplicate'
  | 'unverifiable'
  | 'error';

/** The inferred HuggingFace source for a file, with links and expected values,
 *  attached to a result so the UI can explain a failure. */
export interface HfSummary {
  repoId: string;
  modelUrl: string; // repo page, e.g. https://huggingface.co/unsloth/FLUX.2-klein-9B-GGUF
  fileUrl: string; // file blob page within the repo (on the requested branch/tag)
  commit?: string; // resolved commit SHA the file was verified against, when known
  commitUrl?: string; // file blob page pinned to that commit (an immutable permalink)
  commitDate?: string; // ISO 8601 timestamp of that commit, when known
  expectedSize?: number;
  expectedSha256: string;
  expectedPath: string; // <repoId>/<repoPath>
}

/** One revision inspected while searching a repo's history for a match (see
 *  `findHistoricalMatch`), with why it was ruled out — or that it matched. */
export interface RevisionCheck {
  commit: string; // '' if unknown
  commitDate: string; // ISO 8601, '' if unknown
  commitUrl: string; // file blob page pinned to that revision, '' when no commit
  size: number;
  sha256: string;
  result: 'size-mismatch' | 'sha256-mismatch' | 'match';
}

export interface AuditResult {
  file: string; // path relative to the storage root
  status: AuditStatus;
  message?: string;
  hf?: HfSummary; // present whenever an HF source was inferred
  cached?: boolean; // derived from a sidecar (a prior run), not freshly computed
  // The revisions inspected (latest first) when the file matched none of them;
  // only set on a fresh size/checksum failure, so the UI can show what was
  // ruled out — together with the local file as observed, for comparison:
  revisionsChecked?: RevisionCheck[];
  computedSize?: number;
  computedSha256?: string; // omitted only when hashing failed
}

/**
 * A SHA256 hashing progress event, interleaved with `AuditResult` lines on the
 * audit's NDJSON stream. Distinguished from a result by carrying `hashedBytes`
 * and no `status`. `totalBytes` is the file's on-disk size; a history-walk
 * audit can hash more than once, restarting `hashedBytes` each time.
 */
export interface AuditProgressEvent {
  file: string; // path relative to the storage root
  hashedBytes: number;
  totalBytes: number;
}

/**
 * Streamed when a file's audit job is picked up by a worker. Files selected
 * but not yet started are queued — the UI marks them so while a run
 * serializes (cold storage audits one file at a time). Distinguished from the
 * other NDJSON lines by carrying `started`.
 */
export interface AuditStartEvent {
  file: string; // path relative to the storage root
  started: true;
}

/**
 * A newer-version check result for one file, streamed by the updates endpoint.
 * `status` is the verdict; the `latest*` fields (the repo's current head
 * revision) and `localCommitDate` (the local file's recorded source-commit
 * date) are present only when `status === 'update'`.
 */
export interface UpdateResult {
  file: string; // path relative to the storage root
  status: 'update' | 'current' | 'unknown';
  latestCommit?: string; // head commit SHA
  latestCommitDate?: string; // ISO 8601
  latestCommitUrl?: string; // blob page pinned to the head commit
  localCommitDate?: string; // ISO 8601 — recorded source-commit date of the local file
}

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
 * Network-only update check for one file: read its sidecar, ask Hugging Face for
 * the repo's current head commit of that file, and compare. Returns null when
 * the file isn't checkable (no sidecar, no resolved source, or no recorded
 * `sourceCommit` — e.g. a legacy or unverifiable file). Returns `unknown` when
 * the source is known but HF can't confirm a head commit; otherwise `current`
 * or `update`. Never hashes the local file.
 */
export async function auditFileUpdate(
  basePath: string,
  relPath: string,
): Promise<UpdateResult | null> {
  const meta = await readMetaResolved(basePath, relPath);
  if (!meta?.originUrl || !meta.sourceCommit) return null;
  const ref = parseHfFileUrl(meta.originUrl);
  if (!ref) return null;

  const head = await resolveHfFileByPath(
    ref.repoId,
    canonicalBranch(ref.branch),
    ref.repoPath,
  );
  if (!head?.commit) return {file: relPath, status: 'unknown'};

  const status = decideUpdate(meta.sourceCommit, head.commit);
  if (status !== 'update') return {file: relPath, status};
  return {
    file: relPath,
    status,
    latestCommit: head.commit,
    ...(head.commitDate ? {latestCommitDate: head.commitDate} : {}),
    latestCommitUrl: `https://huggingface.co/${ref.repoId}/blob/${head.commit}/${ref.repoPath}`,
    ...(meta.sourceCommitDate ? {localCommitDate: meta.sourceCommitDate} : {}),
  };
}

export interface TjMeta {
  modelUrl: string; // HF model/repo URL, e.g. https://huggingface.co/unsloth/GLM-4.7-GGUF
  originUrl: string; // HF file URL within the repo
  sourceCommit?: string; // resolved commit SHA the file was verified against, when known
  sourceCommitDate?: string; // ISO 8601 timestamp of that commit, when known
  sourceSize: number; // expected size in bytes, from the HF source (0 if unknown)
  computedSize: number; // actual on-disk size in bytes, observed at audit time
  sourceSha256: string; // '' when no source could be resolved
  computedSha256: string; // '' when the file wasn't hashed (no source, or hashing failed)
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

  let status: AuditStatus;
  let message: string | undefined;
  if (!meta.sourceSha256) {
    status = 'unverifiable';
  } else if (
    typeof meta.computedSize === 'number' &&
    meta.sourceSize > 0 &&
    meta.computedSize !== meta.sourceSize
  ) {
    status = 'incomplete';
    message = `size ${meta.computedSize} != expected ${meta.sourceSize}`;
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

/**
 * SHA256 of a whole file, hashed in-process so `onBytes` can report progress
 * chunk by chunk (the multi-GB hash is the slow part of an audit). Rejects
 * when `signal` aborts mid-read.
 */
export async function localSha256(
  fullPath: string,
  signal?: AbortSignal,
  onBytes?: (n: number) => void,
): Promise<string> {
  const hash = createHash('sha256');
  const rs = createReadStream(fullPath);
  if (onBytes) rs.on('data', (chunk: Buffer | string) => onBytes(chunk.length));
  await pipeline(rs, hash, {signal});
  return hash.digest('hex');
}

export function metaPath(fullPath: string): string {
  return `${fullPath}.tjmeta.json`;
}

export async function readMeta(fullPath: string): Promise<TjMeta | null> {
  try {
    const raw = await fsp.readFile(metaPath(fullPath), 'utf8');
    return JSON.parse(raw) as TjMeta;
  } catch {
    return null;
  }
}

export async function writeMeta(fullPath: string, meta: TjMeta): Promise<void> {
  await fsp.writeFile(metaPath(fullPath), JSON.stringify(meta, null, 2));
}

/**
 * Merge a freshly observed sidecar record into a prior one so an update never
 * replaces known information with less. The source block (URLs, commit pin,
 * expected size/sha) moves atomically: taken wholesale from `next` when this
 * run resolved a source, preserved wholesale from `prev` when it didn't —
 * mixing fields from two resolutions would fabricate a revision that never
 * existed. The observed size is always fresh; the computed hash carries over
 * from `prev` only while the on-disk size is unchanged (same size ⇒ presumed
 * same bytes, the presumption `refreshMetaSource` already makes).
 */
export function mergeMeta(prev: TjMeta | null, next: TjMeta): TjMeta {
  if (!prev) return next;
  const source = next.sourceSha256 ? next : prev;
  const computedSha256 =
    next.computedSha256 ||
    (prev.computedSize === next.computedSize ? prev.computedSha256 : '');
  return {
    modelUrl: source.modelUrl,
    originUrl: source.originUrl,
    ...(source.sourceCommit ? {sourceCommit: source.sourceCommit} : {}),
    ...(source.sourceCommitDate
      ? {sourceCommitDate: source.sourceCommitDate}
      : {}),
    sourceSize: source.sourceSize,
    computedSize: next.computedSize,
    sourceSha256: source.sourceSha256,
    computedSha256,
  };
}

/** Read-merge-write a sidecar update (see `mergeMeta`). */
export async function updateMeta(
  fullPath: string,
  next: TjMeta,
): Promise<void> {
  await writeMeta(fullPath, mergeMeta(await readMeta(fullPath), next));
}

/**
 * Provenance for a file, from its model sidecar (`tjmodel.json`), falling back
 * to a legacy per-file `.tjmeta.json` while the migration is in flight.
 */
export async function readMetaResolved(
  basePath: string,
  relPath: string,
): Promise<TjMeta | null> {
  return (
    (await readFileMetaByPath(basePath, relPath)) ??
    (await readMeta(path.join(basePath, relPath)))
  );
}

/**
 * Read-merge-write a file's provenance into its model sidecar, keyed by its
 * resolved `repoId`. A file with no model dir (a stray at the storage root)
 * falls back to a legacy per-file sidecar — it carries no model sidecar by
 * design (see the model-sidecars spec).
 */
export async function updateMetaResolved(
  basePath: string,
  relPath: string,
  repoId: string,
  next: TjMeta,
): Promise<void> {
  const loc = modelDirForRepo(relPath, repoId);
  if (loc) {
    await upsertFileMeta(basePath, loc.dir, repoId, metaToEntry(loc.key, next));
    return;
  }
  await updateMeta(path.join(basePath, relPath), next);
}

/**
 * Rewrite a file's sidecar to reflect a resolved HF source — its size, sha256
 * and (now corrected) source URLs — preserving the previously computed sha256.
 * A relocation doesn't change the bytes, so the computed hash carries over
 * without re-hashing; only when no prior sidecar recorded one do we fall back to
 * hashing. Used by the Fix flow so a relocated file lands with a complete
 * sidecar even when the original predates a field (e.g. `sourceSize`).
 */
export async function refreshMetaSource(
  basePath: string,
  relPath: string,
  hf: HfFileInfo,
  signal?: AbortSignal,
): Promise<void> {
  const fullPath = path.join(basePath, relPath);
  const prev = await readMetaResolved(basePath, relPath);
  const computedSize = (await fsp.stat(fullPath)).size;
  const computedSha256 =
    prev?.computedSha256 || (await localSha256(fullPath, signal));
  const summary = hfSummary(hf);
  await updateMetaResolved(basePath, relPath, hf.repoId, {
    modelUrl: summary.modelUrl,
    originUrl: summary.fileUrl,
    ...(hf.commit ? {sourceCommit: hf.commit} : {}),
    ...(hf.commitDate ? {sourceCommitDate: hf.commitDate} : {}),
    sourceSize: hf.size,
    computedSize,
    sourceSha256: hf.sha256,
    computedSha256,
  });
}

export interface FixResult {
  file: string; // original path relative to the storage root
  status: 'moved' | 'skipped' | 'error';
  to?: string; // new relative path, when moved
  message?: string;
}

/**
 * Relocate a model file (and its `.tjmeta.json` sidecar, if any) from `fromRel`
 * to `toRel`, both relative to `basePath`, creating intermediate directories.
 * The move within a storage root is a same-filesystem rename. Refuses to escape
 * the root or to overwrite an existing destination.
 */
export async function moveFileWithMeta(
  basePath: string,
  fromRel: string,
  toRel: string,
): Promise<void> {
  const fromFull = path.join(basePath, fromRel);
  const toFull = path.join(basePath, toRel);

  const rel = path.relative(basePath, toFull);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`target escapes storage root: ${toRel}`);
  }

  const destExists = await fsp
    .access(toFull)
    .then(() => true)
    .catch(() => false);
  if (destExists) {
    throw new Error(`destination already exists: ${toRel}`);
  }

  // Read provenance before the move (model sidecar, or a legacy per-file one).
  const meta = await readMetaResolved(basePath, fromRel);

  await fsp.mkdir(path.dirname(toFull), {recursive: true});
  await fsp.rename(fromFull, toFull);

  // Carry the provenance entry to the destination model sidecar and drop it
  // from the source; a move stays within one repo, so the repoId is shared.
  const repoId = meta ? repoIdFromModelUrl(meta.modelUrl) : '';
  if (meta && repoId) {
    const destLoc = modelDirForRepo(toRel, repoId);
    if (destLoc) {
      await upsertFileMeta(
        basePath,
        destLoc.dir,
        repoId,
        metaToEntry(destLoc.key, meta),
      );
    }
    const srcLoc = modelDirForRepo(fromRel, repoId);
    if (srcLoc) await removeFileMeta(basePath, srcLoc.dir, srcLoc.key);
  }
  // Remove an orphaned legacy per-file sidecar left at the source, if any.
  await fsp.rm(metaPath(fromFull), {force: true});
}

/** SHA256 of the first `length` bytes of a file. */
async function sha256Region(
  fullPath: string,
  length: number,
  onBytes?: (n: number) => void,
): Promise<string> {
  const hash = createHash('sha256');
  const rs = createReadStream(fullPath, {start: 0, end: length - 1});
  if (onBytes) rs.on('data', (chunk: Buffer | string) => onBytes(chunk.length));
  await pipeline(rs, hash);
  return hash.digest('hex');
}

/**
 * Where a copy of `srcFull` to `dstFull` may resume: when the destination
 * already holds a prefix of the source — same bytes, verified by hashing the
 * partial file against the same-length region of the source — the copy can
 * skip those bytes and append the rest. Returns 0 (copy from scratch) when the
 * destination is absent, empty, longer than the source, or differs.
 *
 * Hashing a large partial is slow disk I/O; `onVerify` reports its progress as
 * (hashed, total) byte counts — total covers both files, i.e. twice the
 * partial's size. It is only called when a partial actually gets hashed, so a
 * caller can also use it to tell "no partial found" apart from "hashes
 * compared".
 */
export async function resumeOffset(
  srcFull: string,
  dstFull: string,
  onVerify?: (hashedBytes: number, totalBytes: number) => void,
): Promise<number> {
  let dstSize: number;
  try {
    dstSize = (await fsp.stat(dstFull)).size;
  } catch {
    return 0;
  }
  if (dstSize === 0) return 0;
  const srcSize = (await fsp.stat(srcFull)).size;
  if (dstSize > srcSize) return 0;
  let hashed = 0;
  const total = dstSize * 2;
  const onBytes =
    onVerify &&
    ((n: number) => {
      hashed += n;
      onVerify(hashed, total);
    });
  const [dstSha, srcSha] = await Promise.all([
    sha256Region(dstFull, dstSize, onBytes),
    sha256Region(srcFull, dstSize, onBytes),
  ]);
  return dstSha === srcSha ? dstSize : 0;
}

/**
 * Copy a file and its `.tjmeta.json` sidecar (if present) to `dstFull`, creating
 * intermediate directories. Unlike `moveFileWithMeta` this works across
 * filesystems (a stream copy, not a rename), so it's used for the local → cold
 * storage transfer. A destination left behind by an interrupted copy is resumed
 * rather than recopied (see `resumeOffset`). `onBytes` reports copied chunk
 * sizes of the model file for progress — including, up front, the bytes a
 * resume skipped — so progress still sums to the full file size; the sidecar is
 * tiny and not counted.
 */
export async function copyFileWithMeta(
  srcFull: string,
  dstFull: string,
  onBytes?: (n: number) => void,
): Promise<void> {
  await fsp.mkdir(path.dirname(dstFull), {recursive: true});
  const offset = await resumeOffset(srcFull, dstFull);
  if (offset > 0 && onBytes) onBytes(offset);
  const srcSize = (await fsp.stat(srcFull)).size;
  // Skip the stream only when a resume found the destination already complete;
  // offset 0 always streams, so an empty source still creates its destination.
  if (offset === 0 || offset < srcSize) {
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(srcFull, {start: offset});
      // Append on resume; otherwise truncate whatever partial mismatch is there.
      const ws = createWriteStream(dstFull, offset > 0 ? {flags: 'a'} : {});
      if (onBytes)
        rs.on('data', (chunk: Buffer | string) => onBytes(chunk.length));
      rs.once('error', reject);
      ws.once('error', reject);
      ws.once('finish', resolve);
      rs.pipe(ws);
    });
  }

  // Copy the sidecar alongside if it exists; absence is fine.
  try {
    await fsp.copyFile(metaPath(srcFull), metaPath(dstFull));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** How `hf` compares against an on-disk file, as a `RevisionCheck` record. */
function revisionCheck(
  hf: HfFileInfo,
  result: RevisionCheck['result'],
): RevisionCheck {
  return {
    commit: hf.commit,
    commitDate: hf.commitDate,
    commitUrl: hf.commit
      ? `https://huggingface.co/${hf.repoId}/blob/${hf.commit}/${hf.repoPath}`
      : '',
    size: hf.size,
    sha256: hf.sha256,
    result,
  };
}

/**
 * An `onBytes` adapter for `localSha256` that accumulates chunk sizes into
 * (hashedBytes, totalBytes) progress reports — one accumulator per hash run.
 * Undefined when nobody listens, so hashing skips the bookkeeping.
 */
function trackHashProgress(
  totalBytes: number,
  onHashProgress?: (hashedBytes: number, totalBytes: number) => void,
): ((n: number) => void) | undefined {
  if (!onHashProgress) return undefined;
  let done = 0;
  return (n) => {
    done += n;
    onHashProgress(done, totalBytes);
  };
}

/**
 * When the on-disk file doesn't match the latest HF revision (by size or
 * SHA256), walk the repo's commit history looking for an earlier revision of
 * the file that matches what's on disk — the file may simply be an intact
 * older version, not a corrupt one. Inspects each revision's size/sha via
 * paths-info, hashing the local file at most once and only when some
 * revision's size matches. Returns the matching revision's info (`hf`, null
 * when nothing in the first page of history matches), the local file's sha
 * when one was computed, and every distinct revision checked along the way.
 */
export async function findHistoricalMatch(
  fullPath: string,
  hf: HfFileInfo,
  actualSize: number,
  precomputedSha256: string | null,
  signal?: AbortSignal,
  onHashProgress?: (hashedBytes: number, totalBytes: number) => void,
): Promise<{
  hf: HfFileInfo | null;
  computedSha256: string | null;
  checked: RevisionCheck[];
}> {
  const checked: RevisionCheck[] = [];
  let sha = precomputedSha256;
  const commits = await listHfCommits(hf.repoId, hf.branch);
  if (!commits) return {hf: null, computedSha256: sha, checked};
  const seen = new Set([hf.sha256]); // the latest version already failed to match
  for (const commit of commits) {
    const info = await resolveHfFileAtRevision(
      hf.repoId,
      hf.branch,
      commit.id,
      hf.repoPath,
    );
    if (!info || seen.has(info.sha256)) continue;
    seen.add(info.sha256);
    // paths-info may omit the file's last-modifying commit; fall back to the
    // inspected revision so the record still pins a permalink.
    const pinned = info.commit
      ? info
      : {...info, commit: commit.id, commitDate: commit.date};
    if (info.size !== actualSize) {
      checked.push(revisionCheck(pinned, 'size-mismatch'));
      continue;
    }
    if (sha === null) {
      try {
        sha = await localSha256(
          fullPath,
          signal,
          trackHashProgress(actualSize, onHashProgress),
        );
      } catch {
        return {hf: null, computedSha256: null, checked};
      }
    }
    if (sha === info.sha256) {
      checked.push(revisionCheck(pinned, 'match'));
      return {hf: pinned, computedSha256: sha, checked};
    }
    checked.push(revisionCheck(pinned, 'sha256-mismatch'));
  }
  return {hf: null, computedSha256: sha, checked};
}

/**
 * Resolve a file's HuggingFace source, in order: the repo its placement
 * implies, then name inference, then a fall back to the file's own sidecar
 * `originUrl`. Placement goes first because it's deterministic — a correctly
 * placed file names its repo in its path — where search ranking drifts as
 * newer model families flood the results (e.g. LFM2.5 burying LFM2-1.2B).
 * The sidecar fallback is what lets a source set by hand survive — both later
 * audits and the Fix action rely on it, so the audit verdict and the
 * relocation target always agree. Returns null when the source can't be
 * determined.
 */
export async function resolveSource(
  fullPath: string,
  relPath: string,
  modelName: string,
  filename: string,
): Promise<HfFileInfo | null> {
  const cache = parseHubCachePath(relPath);
  // A hub-cache file records its installed revision in the path (`snapshots/
  // <rev>`, = refs/main). Pin the source to that rev — keeping branch `main` so
  // the update check still compares against the branch head — so the sidecar
  // records the actual installed commit, not whatever main points at now.
  if (cache) {
    const atRev = await resolveHfFileByPath(
      cache.repoId,
      cache.rev,
      cache.repoPath,
    );
    if (atRev) return {...atRev, branch: 'main', commit: cache.rev};
  }
  const implied = cache
    ? {repoId: cache.repoId, repoPath: cache.repoPath}
    : pathImpliedRepo(relPath);
  if (implied) {
    const fromPath = await resolveHfFileByPath(
      implied.repoId,
      'main',
      implied.repoPath,
    );
    if (fromPath) return fromPath;
  }
  const inferred = await inferHfFile(modelName, filename);
  if (inferred) return inferred;
  // fullPath is always path.join(basePath, relPath); recover basePath so the
  // sidecar fallback reads the model sidecar (then a legacy per-file one).
  const meta = fullPath.endsWith(relPath)
    ? await readMetaResolved(
        fullPath.slice(0, fullPath.length - relPath.length - 1),
        relPath,
      )
    : await readMeta(fullPath);
  const ref = meta?.originUrl ? parseHfFileUrl(meta.originUrl) : null;
  if (!ref) return null;
  // A sidecar may carry a commit permalink; audit against the branch head so
  // newer revisions are seen (an older file still passes via the history walk).
  return resolveHfFileByPath(
    ref.repoId,
    canonicalBranch(ref.branch),
    ref.repoPath,
  );
}

/** A sidecar record of what an audit has established so far (see `updateMeta`). */
function observedMeta(
  hf: HfFileInfo | null,
  computedSize: number,
  computedSha256: string,
): TjMeta {
  const summary = hf ? hfSummary(hf) : undefined;
  return {
    modelUrl: summary?.modelUrl ?? '',
    originUrl: summary?.fileUrl ?? '',
    ...(hf?.commit ? {sourceCommit: hf.commit} : {}),
    ...(hf?.commitDate ? {sourceCommitDate: hf.commitDate} : {}),
    sourceSize: hf?.size ?? 0,
    computedSize,
    sourceSha256: hf?.sha256 ?? '',
    computedSha256,
  };
}

/**
 * Audit a single physical file: resolve its HF source, check size, hash when it
 * matches, and return the verdict. When the file doesn't match the source's
 * latest revision (by size or checksum), the repo's commit history is searched
 * for an earlier revision that does match (see `findHistoricalMatch`); a match
 * makes that revision the effective source — the verdict, sidecar and summary
 * all pin to it — with a note in the message. A sidecar is *always* written for
 * a file that exists — even with incomplete information (no resolved source, a
 * size mismatch, or a hashing failure) — so every audited file carries a record
 * of what was observed. It is updated as soon as information is established (the
 * resolved source and on-disk size land before the expensive hash) and updates
 * merge rather than overwrite (see `mergeMeta`), so an interrupted audit
 * leaves what it learned and a failed resolution can't erase a prior source.
 * Unknown fields are left empty; the on-disk size is always recorded, letting
 * a later cached audit re-derive the same verdict without re-resolving or
 * re-hashing.
 *
 * The source is found in order: an explicit `source` (a manually-supplied URL,
 * already resolved), then `resolveSource` (inference, then sidecar fallback) —
 * so a source set by hand survives later audit runs even though inference still
 * can't guess it.
 */
export async function auditFile(
  basePath: string,
  relPath: string,
  modelName: string,
  filename: string,
  signal?: AbortSignal,
  source?: HfFileInfo,
  onHashProgress?: (hashedBytes: number, totalBytes: number) => void,
): Promise<AuditResult> {
  const fullPath = path.join(basePath, relPath);

  let actualSize: number;
  try {
    actualSize = (await fsp.stat(fullPath)).size;
  } catch {
    // The file vanished between scan and audit — there's nothing to attest, so
    // no sidecar is written.
    return {file: relPath, status: 'incomplete', message: 'file missing'};
  }

  const latest =
    source ?? (await resolveSource(fullPath, relPath, modelName, filename));

  // Persist what's already known — the source and the on-disk size — before
  // the expensive hash, so an interruption mid-audit doesn't lose it. The
  // merge keeps a prior source alive when this run resolved none.
  try {
    await updateMetaResolved(
      basePath,
      relPath,
      modelName,
      observedMeta(latest, actualSize, ''),
    );
  } catch {
    // best-effort: the final write reports a persistent failure
  }

  // Hash only when there's a source to compare against and the size already
  // matches: a missing source or a size mismatch can't be a checksum pass, so we
  // skip the expensive hash and leave computedSha256 empty.
  let hf = latest;
  let computedSha256: string | null = null;
  let revisionsChecked: RevisionCheck[] | undefined;
  if (latest && actualSize === latest.size) {
    try {
      computedSha256 = await localSha256(
        fullPath,
        signal,
        trackHashProgress(actualSize, onHashProgress),
      );
    } catch {
      computedSha256 = null; // hashing failed → 'error'
    }
    if (computedSha256 !== null && computedSha256 !== latest.sha256) {
      // Same size but different bytes than the latest revision — check whether
      // an earlier revision of the file matches instead.
      const prev = await findHistoricalMatch(
        fullPath,
        latest,
        actualSize,
        computedSha256,
        signal,
        onHashProgress,
      );
      if (prev.hf) hf = prev.hf;
      else
        revisionsChecked = [
          revisionCheck(latest, 'sha256-mismatch'),
          ...prev.checked,
        ];
    }
  } else if (latest) {
    // Size differs from the latest revision — before calling the file
    // incomplete, check whether it is an intact older revision.
    const prev = await findHistoricalMatch(
      fullPath,
      latest,
      actualSize,
      null,
      signal,
      onHashProgress,
    );
    // The search hashes the file as soon as some revision's size matches, so a
    // computed sha may exist even without a match — record it either way.
    computedSha256 = prev.computedSha256;
    if (prev.hf) hf = prev.hf;
    else
      revisionsChecked = [
        revisionCheck(latest, 'size-mismatch'),
        ...prev.checked,
      ];
  }
  // The checked-revisions view always shows the local file's hash, so compute
  // it now if the failure path skipped it (a size mismatch with no same-size
  // revision anywhere in history).
  if (revisionsChecked && computedSha256 === null) {
    try {
      computedSha256 = await localSha256(
        fullPath,
        signal,
        trackHashProgress(actualSize, onHashProgress),
      );
    } catch {
      computedSha256 = null; // shown as unavailable
    }
  }
  const summary = hf ? hfSummary(hf) : undefined;

  // Always record a sidecar, with whatever was determined. The source fields are
  // authoritative when `source` was supplied (the download flow, or a pasted
  // URL); otherwise inferred from the filename, or — when unverifiable — the
  // merge preserves whatever a prior sidecar knew.
  let metaWriteFailed = false;
  try {
    await updateMetaResolved(
      basePath,
      relPath,
      modelName,
      observedMeta(hf ?? null, actualSize, computedSha256 ?? ''),
    );
  } catch {
    metaWriteFailed = true; // non-fatal: still return the verdict
  }

  const status = decideStatus({
    hf: hf ?? null,
    actualSize,
    relPath,
    computedSha256,
  });

  let message: string | undefined;
  if (status === 'incomplete') {
    message = `size ${actualSize} != expected ${hf!.size}`;
  } else if (status === 'error') {
    message = 'sha256sum failed';
  } else if (status === 'misplaced') {
    message = `expected path ${expectedRelPath(hf!)}`;
  }
  if (hf !== latest) {
    const rev = hf!.commit ? ` ${hf!.commit.slice(0, 8)}` : '';
    const note = `matches earlier revision${rev}, not the latest`;
    message = message ? `${message}; ${note}` : note;
  }
  if (metaWriteFailed) {
    message = message
      ? `${message}; metadata write failed`
      : 'metadata write failed';
  }

  return {
    file: relPath,
    status,
    ...(message ? {message} : {}),
    ...(summary ? {hf: summary} : {}),
    ...(revisionsChecked
      ? {
          revisionsChecked,
          computedSize: actualSize,
          ...(computedSha256 ? {computedSha256} : {}),
        }
      : {}),
  };
}
