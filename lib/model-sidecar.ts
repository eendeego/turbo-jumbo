import {promises as fsp} from 'fs';
import path from 'path';
import {parseHubCachePath} from '@/lib/hf-cache';
import type {TjMeta} from '@/lib/audit';

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

function sidecarPath(basePath: string, dir: string): string {
  return path.join(basePath, dir, MODEL_SIDECAR_NAME);
}

export async function readModelSidecar(
  basePath: string,
  dir: string,
): Promise<TjModel | null> {
  try {
    const raw = await fsp.readFile(sidecarPath(basePath, dir), 'utf8');
    return JSON.parse(raw) as TjModel;
  } catch {
    return null;
  }
}

export async function writeModelSidecar(
  basePath: string,
  dir: string,
  model: TjModel,
): Promise<void> {
  const full = sidecarPath(basePath, dir);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, JSON.stringify(model, null, 2));
}

// Per-sidecar-path promise chain: serialize read-modify-write so concurrent
// audits of files in one model don't clobber each other's tjmodel.json.
const writeChains = new Map<string, Promise<unknown>>();

function withSidecarLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

function entryToMeta(modelUrl: string, e: TjModelFile): TjMeta {
  return {
    modelUrl,
    originUrl: e.originUrl,
    ...(e.sourceCommit ? {sourceCommit: e.sourceCommit} : {}),
    ...(e.sourceCommitDate ? {sourceCommitDate: e.sourceCommitDate} : {}),
    sourceSize: e.sourceSize,
    computedSize: e.computedSize,
    sourceSha256: e.sourceSha256,
    computedSha256: e.computedSha256,
  };
}

/** A `TjMeta` as a manifest entry: drop the (hoisted) modelUrl, key by `path`. */
export function metaToEntry(key: string, meta: TjMeta): TjModelFile {
  return {
    path: key,
    originUrl: meta.originUrl,
    ...(meta.sourceCommit ? {sourceCommit: meta.sourceCommit} : {}),
    ...(meta.sourceCommitDate ? {sourceCommitDate: meta.sourceCommitDate} : {}),
    sourceSize: meta.sourceSize,
    computedSize: meta.computedSize,
    sourceSha256: meta.sourceSha256,
    computedSha256: meta.computedSha256,
  };
}

/**
 * A file's `TjMeta` from its model sidecar, located without a known repoId: a
 * hub-cache path resolves directly to its `models--…` dir and in-repo key; a
 * flat path walks up from the file's directory to the nearest ancestor that
 * holds a `tjmodel.json`. Returns null when no model sidecar owns the file.
 */
export async function readFileMetaByPath(
  basePath: string,
  relPath: string,
): Promise<TjMeta | null> {
  const cache = parseHubCachePath(relPath);
  if (cache) {
    return readFileMeta(basePath, relPath.split('/')[0], cache.repoPath);
  }
  let dir = path.dirname(relPath);
  while (dir && dir !== '.') {
    const model = await readModelSidecar(basePath, dir);
    if (model) {
      const key = path.relative(dir, relPath);
      const e = model.files.find((f) => f.path === key);
      return e ? entryToMeta(model.modelUrl, e) : null;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** A file's `TjMeta` view (modelUrl re-attached) from its model sidecar, or null. */
export async function readFileMeta(
  basePath: string,
  dir: string,
  key: string,
): Promise<TjMeta | null> {
  const model = await readModelSidecar(basePath, dir);
  const e = model?.files.find((f) => f.path === key);
  return e ? entryToMeta(model!.modelUrl, e) : null;
}

/** Read-merge-write a file's entry into its model sidecar, serialized per dir. */
export async function upsertFileMeta(
  basePath: string,
  dir: string,
  repoId: string,
  next: TjModelFile,
): Promise<void> {
  await withSidecarLock(sidecarPath(basePath, dir), async () => {
    const model = (await readModelSidecar(basePath, dir)) ?? {
      modelUrl: `https://huggingface.co/${repoId}`,
      repoId,
      files: [],
    };
    const i = model.files.findIndex((f) => f.path === next.path);
    const merged = mergeFileMeta(i >= 0 ? model.files[i] : null, next);
    if (i >= 0) model.files[i] = merged;
    else model.files.push(merged);
    await writeModelSidecar(basePath, dir, model);
  });
}
