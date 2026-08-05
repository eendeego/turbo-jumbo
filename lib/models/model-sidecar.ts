import {promises as fsp} from 'fs';
import path from 'path';
import {parseHubCachePath} from '@/lib/hf/hf-cache';
import type {TjMeta} from '@/lib/models/tjmeta';

import {
  MODEL_SIDECAR_NAME,
  deriveModelCommit,
  type TjModel,
  type TjModelFile,
} from '@/lib/models/sidecar-types';

// The sidecar data model and pure derivations live in a filesystem-free module
// so client components can import them; re-export so existing importers of
// `@/lib/model-sidecar` keep working.
export {
  MIXED_COMMIT,
  MODEL_SIDECAR_NAME,
  deriveModelCommit,
  fileProvenance,
  summarizeFiles,
  summarizeModel,
} from '@/lib/models/sidecar-types';
export type {
  FileProvenance,
  SidecarSummary,
  TjModel,
  TjModelFile,
} from '@/lib/models/sidecar-types';

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
    ...(model.revision ? {revision: model.revision} : {}),
    ...(model.fileScope && model.fileScope.length > 0
      ? {fileScope: model.fileScope}
      : {}),
    files: model.files,
  };
}

// Branch/tag names safe to interpolate into HF API urls (same shape the
// download routes accept).
const REVISION_RE = /^[A-Za-z0-9_./-]+$/;

/**
 * The branch or tag `dir`'s model tracks — its sidecar `revision`, defaulting
 * to `main` when the sidecar is absent, records none, or records something
 * that can't safely go into a URL.
 */
export async function modelRevision(
  basePath: string,
  dir: string,
): Promise<string> {
  const sidecar = await readModelSidecar(basePath, dir);
  const rev = sidecar?.revision;
  return rev && REVISION_RE.test(rev) ? rev : 'main';
}

/**
 * The file set that constitutes a complete copy of `dir`'s model — its
 * sidecar `fileScope` — or null when the model is unscoped (a whole-repo
 * download, judged against the full tree).
 */
export async function modelFileScope(
  basePath: string,
  dir: string,
): Promise<Set<string> | null> {
  const sidecar = await readModelSidecar(basePath, dir);
  const scope = sidecar?.fileScope?.filter((f) => typeof f === 'string');
  return scope && scope.length > 0 ? new Set(scope) : null;
}

/**
 * Record the branch/tag `dir`'s model tracks, and — when the download was
 * deliberately file-scoped — the file set that makes a complete copy.
 * `main` clears the revision (it is the default) and the scope with it: a
 * whole-repo re-download from the default branch untracks both. A pinned
 * download without an explicit scope keeps whatever scope is recorded — a
 * partial re-fetch (the audit's "Download missing files") must not widen
 * the model back to the whole tree. Creates the sidecar when none exists
 * yet — a download whose files all resolve to nothing (small non-LFS
 * companions) must still remember its pin.
 */
export async function setModelRevision(
  basePath: string,
  dir: string,
  repoId: string,
  revision: string,
  fileScope?: string[],
): Promise<void> {
  const existing = await readModelSidecar(basePath, dir);
  const model: TjModel = existing ?? {
    modelUrl: `https://huggingface.co/${repoId}`,
    repoId,
    files: [],
  };
  if (revision === 'main') delete model.revision;
  else model.revision = revision;
  if (fileScope && fileScope.length > 0) model.fileScope = fileScope;
  else if (revision === 'main') delete model.fileScope;
  await writeModelSidecar(basePath, dir, model);
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
 * sidecar has no entries left — and carries no model-level state worth
 * keeping (a revision pin or file scope) — the `tjmodel.json` file is
 * deleted. A pinned/scoped model keeps its empty sidecar: deleting one file
 * must not silently retarget the survivors to main and the whole tree.
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
    const pinned = model.revision != null || (model.fileScope?.length ?? 0) > 0;
    if (model.files.length === 0 && !pinned) {
      await fsp.rm(sidecarPath(basePath, dir), {force: true});
    } else {
      await writeModelSidecar(basePath, dir, withDerivedCommit(model));
    }
  });
}
