import {streamCopyResumable} from '@/lib/audit';
import {coldStorageDir, localModelsDir} from '@/lib/config';
import {logger} from '@/lib/logger';
import {hasStringFiles, readJsonBody} from '@/lib/request';
import nodePath from 'path';
import {promises as fsp} from 'fs';

const EMIT_INTERVAL = 8 * 1024 * 1024; // 8 MB

function resolveWithin(base: string, file: string): string | null {
  const resolved = nodePath.resolve(base, file);
  return resolved.startsWith(base + nodePath.sep) ? resolved : null;
}

/**
 * Copy this host's local-storage files into the cold-storage mount, streaming
 * NDJSON progress. The mirror of `to-local`: the copy route forwards a
 * peer→cold request here so the bytes are read and written entirely on the peer
 * (local disk → the shared cold-storage mount) instead of being proxied through
 * the requesting host — a `cp`-style local copy, not a multi-GB network stream
 * that could outrun a slower sink and exhaust memory. Per-file errors are
 * collected, not fatal; `succeeded` lists the files that reached cold storage so
 * the caller can gate a delete-after-copy on it.
 */
export async function POST(req: Request) {
  if (!coldStorageDir || !localModelsDir)
    return new Response('No local peer configured', {status: 400});

  const body = await readJsonBody<{files: string[]}>(req, hasStringFiles);
  if (body instanceof Response) return body;
  const {files} = body;

  const coldBase = nodePath.resolve(coldStorageDir);
  const localBase = nodePath.resolve(localModelsDir);

  for (const file of files) {
    if (!resolveWithin(localBase, file) || !resolveWithin(coldBase, file))
      return new Response('Invalid path', {status: 400});
  }

  // Sizes come from the local copy (the source of this transfer).
  const fileSizeMap: Record<string, number> = {};
  for (const file of files) {
    try {
      fileSizeMap[file] = (
        await fsp.stat(resolveWithin(localBase, file)!)
      ).size;
    } catch {
      // Missing locally — reported as an error during the copy loop.
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
      const succeeded: string[] = [];
      const errors: string[] = [];

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
              succeeded,
              errors,
            }) + '\n',
          ),
        );

      emit();
      logger.info(`[local→cold] start: ${files.length} file(s)`);

      try {
        for (const file of files) {
          if (fileSizeMap[file] == null) {
            errors.push(`${file}: not found in local storage`);
            emit();
            continue;
          }
          signal.throwIfAborted();

          const src = resolveWithin(localBase, file)!;
          const dst = resolveWithin(coldBase, file)!;

          fileTotal = fileSizeMap[file];
          fileDone = 0;
          emit();

          try {
            let nextEmitAt = EMIT_INTERVAL;
            await streamCopyResumable(src, dst, {
              signal,
              onResume: (offset) => {
                if (offset > 0) {
                  fileDone = offset;
                  bytesDone += offset;
                  nextEmitAt = fileDone + EMIT_INTERVAL;
                  emit();
                }
              },
              onChunk: (n) => {
                fileDone += n;
                bytesDone += n;
                if (fileDone >= nextEmitAt) {
                  nextEmitAt = fileDone + EMIT_INTERVAL;
                  emit();
                }
              },
            });
            filesDone++;
            fileDone = fileTotal;
            succeeded.push(file);
            emit();
          } catch (err) {
            if (signal.aborted) throw err;
            errors.push(
              `${file}: ${err instanceof Error ? err.message : String(err)}`,
            );
            emit();
          }
        }

        logger.info(
          `[local→cold] done: ${succeeded.length}/${files.length} file(s)` +
            (errors.length ? `, ${errors.length} error(s)` : ''),
        );
        safeClose();
      } catch (err) {
        if (signal.aborted) logger.info('[local→cold] cancelled');
        else logger.error('[local→cold] error:', err);
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
