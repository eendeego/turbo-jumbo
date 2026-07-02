import {applyFileMeta, type RepoHead} from '@/lib/storage/copy-meta';
import {localModelsDir} from '@/lib/config';
import {isObject, readJsonBody} from '@/lib/util/request';
import type {TjMeta} from '@/lib/models/tjmeta';
import nodePath from 'path';

type FileMetaRequest = {
  path: string;
  meta: TjMeta;
  repoHead?: RepoHead;
};

function isTjMeta(v: unknown): v is TjMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.modelUrl === 'string' &&
    typeof m.originUrl === 'string' &&
    typeof m.sourceSize === 'number' &&
    typeof m.computedSize === 'number' &&
    typeof m.sourceSha256 === 'string' &&
    typeof m.computedSha256 === 'string'
  );
}

function isRepoHead(v: unknown): v is RepoHead {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.id === 'string' &&
    (h.date === undefined || typeof h.date === 'string')
  );
}

/**
 * Receive one copied file's provenance from the peer that sent its bytes and
 * merge it into this host's sidecars (see lib/storage/copy-meta.ts). The counterpart
 * of `sendFileMeta`; the byte transfer itself goes through `upload`.
 */
export async function POST(req: Request) {
  if (!localModelsDir) return new Response('No local peer', {status: 400});
  const body = await readJsonBody<FileMetaRequest>(req, isObject);
  if (body instanceof Response) return body;
  const {path, meta, repoHead} = body;
  if (typeof path !== 'string' || !isTjMeta(meta))
    return new Response('Invalid body', {status: 400});
  if (repoHead !== undefined && !isRepoHead(repoHead))
    return new Response('Invalid repoHead', {status: 400});

  const base = nodePath.resolve(localModelsDir);
  const full = nodePath.resolve(base, path);
  if (!full.startsWith(base + nodePath.sep))
    return new Response('Invalid path', {status: 400});

  await applyFileMeta(base, path, meta, repoHead);
  return Response.json({ok: true});
}
