import {coldStorageDir, localModelsDir} from '@/lib/config';
import {logger} from '@/lib/logger';
import {hasStringFiles, readJsonBody} from '@/lib/request';
import nodePath from 'path';
import {promises as fsp} from 'fs';
import {createReadStream, createWriteStream} from 'fs';
import {pipeline} from 'stream/promises';
import {Transform} from 'stream';

const EMIT_INTERVAL = 8 * 1024 * 1024; // 8 MB

function makeCounter(onBytes: (n: number) => void): Transform {
  return new Transform({
    transform(chunk, _enc, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

function resolveWithin(base: string, file: string): string | null {
  const resolved = nodePath.resolve(base, file);
  return resolved.startsWith(base + nodePath.sep) ? resolved : null;
}

// Copy files from this peer's own cold storage into its local models dir,
// streaming byte progress. Used so a remote peer can pull from its cold storage
// without routing the data through the orchestrating host.
export async function POST(req: Request) {
  if (!coldStorageDir || !localModelsDir)
    return new Response('No local peer configured', {status: 400});

  const body = await readJsonBody<{files: string[]}>(req, hasStringFiles);
  if (body instanceof Response) return body;
  const {files} = body;

  const coldBase = nodePath.resolve(coldStorageDir);
  const localBase = nodePath.resolve(localModelsDir);

  for (const file of files) {
    if (!resolveWithin(coldBase, file) || !resolveWithin(localBase, file))
      return new Response('Invalid path', {status: 400});
  }

  const fileSizeMap: Record<string, number> = {};
  for (const file of files) {
    try {
      const {size} = await fsp.stat(resolveWithin(coldBase, file)!);
      fileSizeMap[file] = size;
    } catch {
      // Source file missing — will be skipped during copy.
    }
  }

  let filesTotal = 0;
  let bytesTotal = 0;
  for (const file of files) {
    if (fileSizeMap[file] != null) {
      filesTotal++;
      bytesTotal += fileSizeMap[file];
    }
  }

  const enc = new TextEncoder();
  const abortController = new AbortController();
  req.signal.addEventListener('abort', () => abortController.abort(), {
    once: true,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const {signal} = abortController;
      let closed = false;
      const safeEnqueue = (data: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(data);
        } catch {
          closed = true;
          abortController.abort();
        }
      };
      const safeClose = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      let filesDone = 0;
      let bytesDone = 0;
      let fileDone = 0;
      let fileTotal = 0;

      const emit = () =>
        safeEnqueue(
          enc.encode(
            JSON.stringify({
              filesDone,
              filesTotal,
              fileDone,
              fileTotal,
              bytesDone,
              bytesTotal,
            }) + '\n',
          ),
        );

      emit();
      logger.info(`[cold→local] start: ${files.length} file(s)`);

      try {
        for (const file of files) {
          if (fileSizeMap[file] == null) {
            logger.debug(`[cold→local] skipping ${file}: not in cold storage`);
            continue;
          }

          signal.throwIfAborted();

          const src = resolveWithin(coldBase, file)!;
          const dst = resolveWithin(localBase, file)!;
          await fsp.mkdir(nodePath.dirname(dst), {recursive: true});

          fileTotal = fileSizeMap[file];
          fileDone = 0;
          emit();

          let nextEmitAt = EMIT_INTERVAL;
          const counter = makeCounter((n) => {
            fileDone += n;
            bytesDone += n;
            if (fileDone >= nextEmitAt) {
              nextEmitAt = fileDone + EMIT_INTERVAL;
              emit();
            }
          });

          await pipeline(
            createReadStream(src),
            counter,
            createWriteStream(dst),
            {
              signal,
            },
          );

          filesDone++;
          fileDone = fileTotal;
          emit();
        }

        logger.info(`[cold→local] done: ${files.length} file(s)`);
        safeClose();
      } catch (err) {
        if (signal.aborted) logger.info('[cold→local] cancelled');
        else logger.error('[cold→local] error:', err);
        safeClose();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {'Content-Type': 'application/x-ndjson'},
  });
}
