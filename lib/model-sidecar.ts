import {promises as fsp} from 'fs';
import path from 'path';
import {parseHubCachePath} from '@/lib/hf-cache';
import type {TjMeta} from '@/lib/tjmeta';

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
  missing?: boolean; // expected on HF but absent locally (recorded by the audit)
}

/** A model's sidecar: shared identity plus one record per file. */
export interface TjModel {
  modelUrl: string; // https://huggingface.co/<repoId>
  repoId: string;
  // The model's revision, derived from its files: the shared file `sourceCommit`
  // when they all agree, `MIXED_COMMIT` when they don't (or one is missing),
  // omitted when no file records a commit. Maintained by upsert/remove.
  sourceCommit?: string;
  // The repo's HEAD commit on its branch — the revision HuggingFace's cache names
  // its `snapshots/<rev>/` directory after (e.g. what Lemonade mirrors). Unlike
  // `sourceCommit` this is repo-level, not derived from files: it's resolved from
  // HF during audit and set directly. Omitted until an audit resolves it.
  repoCommit?: string;
  repoCommitDate?: string; // ISO 8601 date of `repoCommit`, when known
  files: TjModelFile[];
}

/** The model `sourceCommit` value signalling files disagree on their revision. */
export const MIXED_COMMIT = 'mixed';

/** A model's sidecar reduced to its model-level fields plus a file roll-up. */
export interface SidecarSummary {
  repoId: string;
  modelUrl: string;
  sourceCommit?: string; // file-derived; may be MIXED_COMMIT
  repoCommit?: string; // repo HEAD commit
  repoCommitDate?: string; // ISO 8601 date of repoCommit
  fileCount: number;
  totalSourceSize: number;
}

/** The model-level summary of a parsed sidecar, for the model-name hovercard. */
export function summarizeModel(model: TjModel): SidecarSummary {
  const files = model.files ?? [];
  return {
    repoId: model.repoId,
    modelUrl: model.modelUrl,
    ...(model.sourceCommit ? {sourceCommit: model.sourceCommit} : {}),
    ...(model.repoCommit ? {repoCommit: model.repoCommit} : {}),
    ...(model.repoCommitDate ? {repoCommitDate: model.repoCommitDate} : {}),
    fileCount: files.length,
    totalSourceSize: files.reduce((sum, f) => sum + (f.sourceSize ?? 0), 0),
  };
}

/**
 * A model's revision from its files: the shared `sourceCommit` when every file
 * has it and they all match, `MIXED_COMMIT` when they differ or any file is
 * missing one, and undefined when no file records a commit at all.
 */
export function deriveModelCommit(files: TjModelFile[]): string | undefined {
  const defined = files
    .map((f) => f.sourceCommit)
    .filter((c): c is string => !!c);
  if (defined.length === 0) return undefined;
  const allPresentAndEqual =
    defined.length === files.length && new Set(defined).size === 1;
  return allPresentAndEqual ? defined[0] : MIXED_COMMIT;
}

/** A model sidecar with its `sourceCommit` recomputed from its files. */
function withDerivedCommit(model: TjModel): TjModel {
  const sourceCommit = deriveModelCommit(model.files);
  return {
    modelUrl: model.modelUrl,
    repoId: model.repoId,
    ...(sourceCommit ? {sourceCommit} : {}),
    // Repo-level, not derived: carry through whatever the model already records.
    ...(model.repoCommit ? {repoCommit: model.repoCommit} : {}),
    ...(model.repoCommitDate ? {repoCommitDate: model.repoCommitDate} : {}),
    files: model.files,
  };
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
    // The latest observation wins: a present audit clears the flag, a
    // missing-file record sets it.
    ...(next.missing ? {missing: true} : {}),
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

/**
 * Every model directory under `basePath` that holds a `tjmodel.json`, as paths
 * relative to `basePath`. Used to enumerate sidecar-only state (e.g. files
 * recorded `missing`) that an on-disk scan can't see. A directory with a
 * sidecar isn't descended into — a model dir doesn't nest another.
 */
export async function findModelSidecarDirs(
  basePath: string,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(path.join(basePath, dir), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === MODEL_SIDECAR_NAME)) {
      out.push(dir);
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(dir ? path.join(dir, e.name) : e.name);
    }
  }
  await walk('');
  return out;
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

export function entryToMeta(modelUrl: string, e: TjModelFile): TjMeta {
  return {
    modelUrl,
    originUrl: e.originUrl,
    ...(e.sourceCommit ? {sourceCommit: e.sourceCommit} : {}),
    ...(e.sourceCommitDate ? {sourceCommitDate: e.sourceCommitDate} : {}),
    sourceSize: e.sourceSize,
    computedSize: e.computedSize,
    sourceSha256: e.sourceSha256,
    computedSha256: e.computedSha256,
    ...(e.missing ? {missing: true} : {}),
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
    ...(meta.missing ? {missing: true} : {}),
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

/**
 * Read-merge-write a file's entry into its model sidecar, serialized per dir.
 * When `repoHead` is given it sets the model-level `repoCommit`/`repoCommitDate`;
 * when omitted, any value the sidecar already records is preserved (callers
 * without a fresh HF resolution — moves, legacy migration — never clobber it).
 */
export async function upsertFileMeta(
  basePath: string,
  dir: string,
  repoId: string,
  next: TjModelFile,
  repoHead?: {id: string; date?: string} | null,
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
    if (repoHead?.id) {
      model.repoCommit = repoHead.id;
      if (repoHead.date) model.repoCommitDate = repoHead.date;
      else delete model.repoCommitDate;
    }
    await writeModelSidecar(basePath, dir, withDerivedCommit(model));
  });
}

/**
 * Clear a file's `missing` flag once it's present on disk, recording its size.
 * Returns whether a flag was actually cleared — a no-op (false) when the file
 * has no entry or wasn't flagged. The downloader uses this for files whose HF
 * source can't be resolved (small non-LFS files like `index.json`): `auditFile`
 * can't record them, but a just-downloaded file must not stay flagged missing.
 */
export async function clearMissingFlag(
  basePath: string,
  dir: string,
  key: string,
  computedSize: number,
): Promise<boolean> {
  return withSidecarLock(sidecarPath(basePath, dir), async () => {
    const model = await readModelSidecar(basePath, dir);
    const i = model?.files.findIndex((f) => f.path === key) ?? -1;
    if (!model || i < 0 || !model.files[i].missing) return false;
    const entry = {...model.files[i], computedSize};
    delete entry.missing;
    model.files[i] = entry;
    await writeModelSidecar(basePath, dir, withDerivedCommit(model));
    return true;
  });
}

/**
 * Remove a file's entry from its model sidecar, serialized per dir. When the
 * sidecar has no entries left, the `tjmodel.json` file is deleted.
 */
export async function removeFileMeta(
  basePath: string,
  dir: string,
  key: string,
): Promise<void> {
  await withSidecarLock(sidecarPath(basePath, dir), async () => {
    const model = await readModelSidecar(basePath, dir);
    if (!model) return;
    model.files = model.files.filter((f) => f.path !== key);
    if (model.files.length === 0) {
      await fsp.rm(sidecarPath(basePath, dir), {force: true});
    } else {
      await writeModelSidecar(basePath, dir, withDerivedCommit(model));
    }
  });
}
