import {promises as fsp} from 'fs';
import path from 'path';
import {logger} from '@/lib/util/logger';
import {repoIdFromModelUrl} from '@/lib/models/model-name';
import {
  metaToEntry,
  modelDirForRepo,
  readFileMetaByPath,
  upsertFileMeta,
} from '@/lib/models/model-sidecar';
import {TJMETA_SUFFIX} from '@/lib/models/sidecar-types';

export interface TjMeta {
  modelUrl: string; // HF model/repo URL, e.g. https://huggingface.co/unsloth/GLM-4.7-GGUF
  originUrl: string; // HF file URL within the repo
  sourceCommit?: string; // resolved commit SHA the file was verified against, when known
  sourceCommitDate?: string; // ISO 8601 timestamp of that commit, when known
  sourceSize: number; // expected size in bytes, from the HF source (0 if unknown)
  computedSize: number; // actual on-disk size in bytes, observed at audit time
  sourceSha256: string; // '' when no source could be resolved
  computedSha256: string; // '' when the file wasn't hashed (no source, or hashing failed)
  missing?: boolean; // the file is expected on HF but absent locally (no on-disk copy)
}

export function metaPath(fullPath: string): string {
  return `${fullPath}${TJMETA_SUFFIX}`;
}

export async function readMeta(fullPath: string): Promise<TjMeta | null> {
  const file = metaPath(fullPath);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    // A missing sidecar is the common, expected case (most files have none);
    // anything else (a permission error, an I/O fault) is worth surfacing.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[meta] failed to read ${file}:`, e);
    }
    return null;
  }
  try {
    return JSON.parse(raw) as TjMeta;
  } catch (e) {
    // A corrupt sidecar is a real problem, not the same as "no record" — log it
    // rather than silently re-resolving and overwriting whatever it held.
    logger.warn(`[meta] ignoring unparseable sidecar ${file}:`, e);
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
  const fromModel = await readFileMetaByPath(basePath, relPath);
  if (fromModel) return fromModel;
  const legacy = await readMeta(path.join(basePath, relPath));
  if (legacy) {
    // Lazily migrate a legacy per-file sidecar into the model sidecar (when the
    // file sits in a model dir), then drop the legacy file.
    const repoId = repoIdFromModelUrl(legacy.modelUrl);
    const loc = repoId ? modelDirForRepo(relPath, repoId) : null;
    if (repoId && loc) {
      await upsertFileMeta(
        basePath,
        loc.dir,
        repoId,
        metaToEntry(loc.key, legacy),
      );
      await fsp.rm(metaPath(path.join(basePath, relPath)), {force: true});
    }
  }
  return legacy;
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
  repoHead?: {id: string; date?: string} | null,
): Promise<void> {
  const loc = modelDirForRepo(relPath, repoId);
  if (loc) {
    await upsertFileMeta(
      basePath,
      loc.dir,
      repoId,
      metaToEntry(loc.key, next),
      repoHead,
    );
    return;
  }
  // A stray file with no model dir keeps a legacy per-file sidecar (harmless
  // backward-compat); the model-sidecars spec accepts no provenance for these.
  await updateMeta(path.join(basePath, relPath), next);
}
