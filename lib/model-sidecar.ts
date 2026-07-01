import {parseHubCachePath} from '@/lib/hf-cache';

export const MODEL_SIDECAR_NAME = 'tjmodel.json';

/** A per-file provenance record inside a model sidecar (a TjMeta without modelUrl). */
export interface TjModelFile {
  path: string; // file path relative to the model dir (the manifest key)
  originUrl: string;
  sourceCommit?: string;
  sourceCommitDate?: string;
  sourceSize: number;
  computedSize: number;
  sourceSha256: string;
  computedSha256: string;
}

/** A model's sidecar: shared identity plus one record per file. */
export interface TjModel {
  modelUrl: string; // https://huggingface.co/<repoId>
  repoId: string;
  files: TjModelFile[];
}

/**
 * The model directory (storage-root-relative) that owns `relPath`, and the
 * file's key within it, given the file's resolved `repoId`. The repoId is
 * required because a leading path segment alone can't tell a one-part repo id
 * (`gpt2`) from the org of a two-part one (`unsloth/…`). Returns null when the
 * file isn't under its repo dir (e.g. a stray file at the storage root — such
 * files carry no model sidecar by design).
 *
 * - hub-cache: `models--<org>--<repo>/snapshots/<rev>/<repoPath>` →
 *   dir = the `models--…` segment, key = `<repoPath>`.
 * - flat: `<repoId>/<repoPath>` → dir = `<repoId>`, key = `<repoPath>`.
 */
export function modelDirForRepo(
  relPath: string,
  repoId: string,
): {dir: string; key: string} | null {
  const cache = parseHubCachePath(relPath);
  if (cache && cache.repoId === repoId) {
    return {dir: relPath.split('/')[0], key: cache.repoPath};
  }
  const prefix = `${repoId}/`;
  if (relPath.startsWith(prefix)) {
    return {dir: repoId, key: relPath.slice(prefix.length)};
  }
  return null;
}

/**
 * Merge a freshly observed file record into a prior one without losing known
 * information. The source block (urls, commit pin, expected size/sha) moves
 * atomically — wholesale from `next` when it resolved a source, else from
 * `prev`. The observed size is always fresh; the computed hash carries from
 * `prev` only while the on-disk size is unchanged.
 */
export function mergeFileMeta(
  prev: TjModelFile | null,
  next: TjModelFile,
): TjModelFile {
  if (!prev) return next;
  const source = next.sourceSha256 ? next : prev;
  const computedSha256 =
    next.computedSha256 ||
    (prev.computedSize === next.computedSize ? prev.computedSha256 : '');
  return {
    path: next.path,
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
