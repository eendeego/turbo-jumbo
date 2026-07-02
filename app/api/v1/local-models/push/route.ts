import {localModelsDir} from '@/lib/config';
import {readFileMetaWithRepoHead, sendFileMeta} from '@/lib/copy-meta';
import {logger} from '@/lib/logger';
import {hasStringFiles, readJsonBody} from '@/lib/request';
import nodePath from 'path';
import {promises as fsp} from 'fs';
import {createReadStream} from 'fs';
import {Readable} from 'stream';

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB

type PushRequest = {
  files: string[];
  toPeer: string;
};

export async function POST(req: Request) {
  if (!localModelsDir) return new Response('No local peer', {status: 400});
  const body = await readJsonBody<PushRequest>(req, hasStringFiles);
  if (body instanceof Response) return body;
  const {files, toPeer} = body;

  if (typeof toPeer !== 'string' || !toPeer)
    return new Response('Invalid toPeer', {status: 400});

  const base = nodePath.resolve(localModelsDir);

  logger.info(`[push] start: ${files.length} file(s) → ${toPeer}`);

  // Once a file's bytes are up, hand the destination its provenance so it
  // names and audits the copy without a re-hash. Best effort: a meta failure
  // is reported to the caller but doesn't fail the push.
  const metaErrors: string[] = [];
  const sendMetaFor = async (file: string) => {
    try {
      const payload = await readFileMetaWithRepoHead(base, file);
      if (payload) await sendFileMeta(toPeer, file, payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[push] meta failed for ${file} → ${toPeer}: ${msg}`);
      metaErrors.push(`${file}: meta: ${msg}`);
    }
  };

  for (const file of files) {
    const full = nodePath.resolve(base, file);
    if (!full.startsWith(base + nodePath.sep))
      return new Response('Invalid path', {status: 400});

    const {size: fileSize} = await fsp.stat(full);
    const uploadUrl = `http://${toPeer}/api/v1/local-models/upload`;

    logger.info(`[push] upload ${file} → ${toPeer}`);
    if (fileSize === 0) {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {'x-file-path': file, 'x-chunk-offset': '0'},
      });
      if (!res.ok) {
        logger.error(
          `[push] upload failed for ${file} → ${toPeer}: ${res.status}`,
        );
        return new Response(`Upload to peer failed: ${await res.text()}`, {
          status: 502,
        });
      }
      await sendMetaFor(file);
      continue;
    }

    for (let offset = 0; offset < fileSize; offset += CHUNK_SIZE) {
      const chunkEnd = Math.min(offset + CHUNK_SIZE, fileSize);
      logger.debug(`[push] upload chunk ${file} offset=${offset} → ${toPeer}`);
      const readable = createReadStream(full, {
        start: offset,
        end: chunkEnd - 1,
      });
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'x-file-path': file,
          'x-chunk-offset': String(offset),
          'Content-Type': 'application/octet-stream',
        },
        body: Readable.toWeb(readable) as unknown as BodyInit,
        // @ts-expect-error – duplex required for streaming request bodies in Node fetch
        duplex: 'half',
      });
      if (!res.ok) {
        logger.error(
          `[push] upload failed for ${file} offset=${offset} → ${toPeer}: ${res.status}`,
        );
        return new Response(`Upload to peer failed: ${await res.text()}`, {
          status: 502,
        });
      }
    }
    await sendMetaFor(file);
  }

  logger.info(`[push] done: ${files.length} file(s) → ${toPeer}`);

  return Response.json({
    ok: true,
    ...(metaErrors.length ? {metaErrors} : {}),
  });
}
