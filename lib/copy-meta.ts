import path from 'path';
import {repoIdFromModelUrl} from '@/lib/model-name';
import {modelDirForRepo, readModelSidecar} from '@/lib/model-sidecar';
import {
  readMetaResolved,
  updateMeta,
  updateMetaResolved,
  type TjMeta,
} from '@/lib/tjmeta';

export interface RepoHead {
  id: string;
  date?: string;
}

/** A file's provenance plus its model's repo-level commit, ready to travel. */
export interface FileMetaPayload {
  meta: TjMeta;
  repoHead?: RepoHead;
}

/**
 * Source side of a copy: a file's provenance entry together with its model
 * sidecar's repo-level commit. Null when the file has no recorded provenance —
 * a copy never fabricates one.
 */
export async function readFileMetaWithRepoHead(
  srcBase: string,
  relPath: string,
): Promise<FileMetaPayload | null> {
  const meta = await readMetaResolved(srcBase, relPath);
  if (!meta) return null;
  const repoId = repoIdFromModelUrl(meta.modelUrl);
  const loc = repoId ? modelDirForRepo(relPath, repoId) : null;
  const model = loc ? await readModelSidecar(srcBase, loc.dir) : null;
  return {
    meta,
    ...(model?.repoCommit
      ? {
          repoHead: {
            id: model.repoCommit,
            ...(model.repoCommitDate ? {date: model.repoCommitDate} : {}),
          },
        }
      : {}),
  };
}

/**
 * Destination side of a copy: merge one file's provenance into this base's
 * sidecars (model sidecar when the file sits in a model dir, legacy per-file
 * sidecar otherwise). The forwarded `repoHead` applies only when the
 * destination sidecar records no repoCommit of its own — a copy is not a fresh
 * HF resolution and must not clobber a newer observation here.
 */
export async function applyFileMeta(
  dstBase: string,
  relPath: string,
  meta: TjMeta,
  repoHead?: RepoHead,
): Promise<void> {
  const repoId = repoIdFromModelUrl(meta.modelUrl);
  if (!repoId) {
    await updateMeta(path.join(dstBase, relPath), meta);
    return;
  }
  let head = repoHead;
  if (head) {
    const loc = modelDirForRepo(relPath, repoId);
    const dest = loc ? await readModelSidecar(dstBase, loc.dir) : null;
    if (dest?.repoCommit) head = undefined;
  }
  await updateMetaResolved(dstBase, relPath, repoId, meta, head);
}

/** Both sides at once, for legs where source and destination are local paths. */
export async function propagateFileMeta(
  srcBase: string,
  dstBase: string,
  relPath: string,
): Promise<void> {
  const payload = await readFileMetaWithRepoHead(srcBase, relPath);
  if (!payload) return;
  await applyFileMeta(dstBase, relPath, payload.meta, payload.repoHead);
}

/** Network leg: hand a file's provenance to the destination peer to apply. */
export async function sendFileMeta(
  peerAddr: string,
  relPath: string,
  payload: FileMetaPayload,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`http://${peerAddr}/api/v1/local-models/file-meta`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      path: relPath,
      meta: payload.meta,
      ...(payload.repoHead ? {repoHead: payload.repoHead} : {}),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
