import {promises as fsp} from 'fs';
import path from 'path';
import {
  expectedRelPath,
  findHistoricalMatch,
  hfSummary,
  localSha256,
  metaPath,
  moveFileWithMeta,
  resolveSource,
  updateMetaResolved,
} from '@/lib/audit';
import type {HfFileInfo} from '@/lib/hf-infer';
import {modelDirForRepo, removeFileMeta} from '@/lib/model-sidecar';

export interface DuplicateFixResult {
  file: string; // original path relative to the storage root
  status: 'kept' | 'deleted' | 'skipped' | 'error';
  to?: string; // kept file's new path, when moved
  message?: string;
}

/** A copy of the duplicated file as observed on disk, with the revision it
 *  matches (when valid). */
interface Copy {
  relPath: string;
  size: number;
  sha256: string;
  matched?: HfFileInfo;
}

/**
 * Resolve one duplicate group — every same-basename copy of a file within a
 * storage location — down to a single verified copy at its HF expected path.
 *
 * Conservative by construction: nothing is deleted unless the source resolves,
 * every copy hashes, and at least one copy verifies against some revision.
 * Among valid copies the survivor is the one pinned to the newest revision
 * (so a latest-revision match beats a historical one and identical copies tie);
 * ties prefer the copy already at the expected path, then the lexicographically
 * first path for determinism. All other copies — older revisions and invalid
 * bytes — are deleted along with their sidecars, and the survivor is moved to
 * the expected path with a sidecar rebuilt from the verified source and the
 * freshly computed hash (not `refreshMetaSource`, which would trust a possibly
 * stale prior sidecar hash over the one just computed).
 */
export async function fixDuplicateGroup(
  basePath: string,
  relPaths: string[],
  modelName: string,
  filename: string,
  signal?: AbortSignal,
): Promise<DuplicateFixResult[]> {
  const skipAll = (message: string) =>
    relPaths.map((file): DuplicateFixResult => ({
      file,
      status: 'skipped',
      message,
    }));

  if (relPaths.length < 2) return skipAll('not a duplicate');

  // Resolve the source once. Inference keys on model name + filename — the
  // same for every copy — but the placement and sidecar-URL lookups are per
  // copy, so try each until one resolves.
  let source: HfFileInfo | null = null;
  for (const relPath of relPaths) {
    source = await resolveSource(
      path.join(basePath, relPath),
      relPath,
      modelName,
      filename,
    );
    if (source) break;
  }
  if (!source) return skipAll('unverifiable');

  // Stat and hash every copy. An unhashable copy can't be ruled in or out as
  // the survivor, so any failure forfeits the whole group.
  const copies: Copy[] = [];
  for (const relPath of relPaths) {
    const full = path.join(basePath, relPath);
    try {
      const size = (await fsp.stat(full)).size;
      const sha256 = await localSha256(full, signal);
      copies.push({relPath, size, sha256});
    } catch {
      return skipAll(`could not hash ${relPath}`);
    }
  }

  // Classify each copy: valid when it matches the latest revision or an
  // earlier one (the same history search the audit uses), pinning that
  // revision. Identical copies share a verdict, so classify once per sha.
  const bySha = new Map<string, HfFileInfo | null>();
  for (const copy of copies) {
    if (!bySha.has(copy.sha256)) {
      let matched: HfFileInfo | null = null;
      if (copy.size === source.size && copy.sha256 === source.sha256) {
        matched = source;
      } else {
        const prev = await findHistoricalMatch(
          path.join(basePath, copy.relPath),
          source,
          copy.size,
          copy.sha256,
          signal,
        );
        matched = prev.hf;
      }
      bySha.set(copy.sha256, matched);
    }
    copy.matched = bySha.get(copy.sha256) ?? undefined;
  }

  const valid = copies.filter((c) => c.matched);
  if (valid.length === 0) return skipAll('no valid copy');

  // Pick the survivor. ISO dates compare lexicographically; an unknown date
  // ('') loses to any known one.
  const target = expectedRelPath(source);
  const survivor = valid.reduce((best, c) => {
    if (best.matched!.commitDate !== c.matched!.commitDate) {
      return best.matched!.commitDate > c.matched!.commitDate ? best : c;
    }
    const bestPlaced = best.relPath === target;
    if (bestPlaced !== (c.relPath === target)) return bestPlaced ? best : c;
    return best.relPath <= c.relPath ? best : c;
  });

  // Delete every other copy (older revisions and invalid bytes) with its
  // sidecar. A failure is reported per copy without stopping the others.
  const results: DuplicateFixResult[] = [];
  for (const copy of copies) {
    if (copy === survivor) continue;
    const full = path.join(basePath, copy.relPath);
    try {
      await fsp.rm(full);
      await fsp.rm(metaPath(full), {force: true});
      const loc = copy.matched
        ? modelDirForRepo(copy.relPath, copy.matched.repoId)
        : null;
      if (loc) await removeFileMeta(basePath, loc.dir, loc.key);
      results.push({file: copy.relPath, status: 'deleted'});
    } catch (e) {
      results.push({
        file: copy.relPath,
        status: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Place the survivor at the expected path and rebuild its sidecar from the
  // pinned revision plus the hash computed above. If a loser's deletion failed
  // and it still occupies the target, moveFileWithMeta's destination check
  // refuses and the survivor stays put, reported as an error.
  const pinned = survivor.matched!;
  let status: DuplicateFixResult['status'] = 'kept';
  let to: string | undefined;
  let message: string | undefined;
  try {
    if (survivor.relPath !== target) {
      await moveFileWithMeta(basePath, survivor.relPath, target);
      to = target;
    }
    const summary = hfSummary(pinned);
    await updateMetaResolved(basePath, to ?? survivor.relPath, pinned.repoId, {
      modelUrl: summary.modelUrl,
      originUrl: summary.fileUrl,
      ...(pinned.commit ? {sourceCommit: pinned.commit} : {}),
      ...(pinned.commitDate ? {sourceCommitDate: pinned.commitDate} : {}),
      sourceSize: pinned.size,
      computedSize: survivor.size,
      sourceSha256: pinned.sha256,
      computedSha256: survivor.sha256,
    });
  } catch (e) {
    status = 'error';
    message = e instanceof Error ? e.message : String(e);
  }
  results.push({
    file: survivor.relPath,
    status,
    ...(to ? {to} : {}),
    ...(message ? {message} : {}),
  });
  return results;
}
