import {localModelsDir, coldStorageDir, localPeer} from '@/lib/config';
import {logger} from '@/lib/logger';
import {promises as fsp} from 'fs';
import {createReadStream, createWriteStream} from 'fs';
import nodePath from 'path';
import {pipeline} from 'stream/promises';
import {Readable, Transform} from 'stream';

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB
// Emit a progress event at most once per this many streamed bytes.
const EMIT_INTERVAL = CHUNK_SIZE;

type CopyRequest = {
  files: string[];
  from: string; // "cold-storage" | peer address (the local peer's own address for local source)
  toColdStorage: boolean;
  toPeers: string[]; // may include the local peer's address
  deleteAfterCopy: boolean;
  fileSizes?: Record<string, number>; // caller-supplied sizes for peer sources
  skip?: Array<{file: string; destination: string}>; // file+destination pairs to skip
};

function resolveLocal(basePath: string, file: string): string | null {
  const base = nodePath.resolve(basePath);
  const full = nodePath.resolve(base, file);
  return full.startsWith(base + nodePath.sep) ? full : null;
}

// A pass-through stream that reports how many bytes flow through it.
function makeCounter(onBytes: (n: number) => void): Transform {
  return new Transform({
    transform(chunk, _enc, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as CopyRequest;
  const {files, from, toColdStorage, toPeers, deleteAfterCopy} = body;

  // file+destination pairs the user chose not to overwrite (see /api/v1/copy/check).
  const skipSet = new Set(
    (body.skip ?? []).map((s) => `${s.file}\0${s.destination}`),
  );
  const shouldSkip = (file: string, dest: string) =>
    skipSet.has(`${file}\0${dest}`);

  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))
    return new Response('Invalid files', {status: 400});

  // The local peer is just another peer address; "from"/"toPeers" use it for
  // local source/destination instead of a special "local" token.
  const localPeerAddr = localPeer?.address ?? '';
  const isPeerSource = from !== 'cold-storage' && from !== localPeerAddr;
  const sourceBasePath =
    from === localPeerAddr
      ? localModelsDir
      : from === 'cold-storage'
        ? coldStorageDir
        : null;

  if (!isPeerSource && !sourceBasePath)
    return new Response('No local peer configured', {status: 400});
  if (toColdStorage && !coldStorageDir)
    return new Response('No cold storage configured', {status: 400});

  const coldBase = coldStorageDir ? nodePath.resolve(coldStorageDir) : '';
  const localBase = localModelsDir ? nodePath.resolve(localModelsDir) : '';

  // Validate local source paths up-front
  if (!isPeerSource && sourceBasePath) {
    for (const file of files) {
      if (!resolveLocal(sourceBasePath, file))
        return new Response('Invalid path', {status: 400});
    }
  }

  // Build a file-size map: stat local files, or use caller-supplied sizes when
  // the source is a remote peer (whose files this server can't stat).
  const fileSizeMap: Record<string, number> = {};
  if (!isPeerSource && sourceBasePath) {
    for (const file of files) {
      try {
        const {size} = await fsp.stat(resolveLocal(sourceBasePath, file)!);
        fileSizeMap[file] = size;
      } catch {
        // Source file missing — skip it.
      }
    }
  } else if (body.fileSizes) {
    Object.assign(fileSizeMap, body.fileSizes);
  }

  let filesTotal = 0;
  let bytesTotal = 0;
  if (toColdStorage) {
    for (const file of files) {
      if (!shouldSkip(file, 'cold-storage')) {
        filesTotal++;
        bytesTotal += fileSizeMap[file] ?? 0;
      }
    }
  }
  for (const peerAddr of toPeers) {
    // A push to a remote peer counts as one op; everything else is per-file.
    if (isPeerSource && peerAddr !== localPeerAddr) {
      const nonSkipped = files.filter((f) => !shouldSkip(f, peerAddr));
      if (nonSkipped.length > 0) {
        filesTotal++;
        bytesTotal += nonSkipped.reduce((s, f) => s + (fileSizeMap[f] ?? 0), 0);
      }
    } else {
      for (const file of files) {
        if (!shouldSkip(file, peerAddr)) {
          filesTotal++;
          bytesTotal += fileSizeMap[file] ?? 0;
        }
      }
    }
  }

  const enc = new TextEncoder();
  const abortController = new AbortController();

  // Abort in-flight transfers when the client disconnects. req.signal fires on
  // disconnect in Next.js/Bun; the stream's cancel() is a fallback for runtimes
  // that surface cancellation that way instead.
  req.signal.addEventListener('abort', () => abortController.abort(), {
    once: true,
  });

  // Stream newline-delimited progress so the browser can render a live bar.
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

      emit(); // initial event

      const destinations = [
        ...(toColdStorage ? ['cold-storage'] : []),
        ...toPeers,
      ];
      logger.info(
        `[copy] start: ${files.length} file(s) from ${from} → ${destinations.join(', ')}`,
      );

      // Copy one file (from the local/cold/peer source) into a local directory
      // tree, streaming byte progress. Returns false on an invalid or failed
      // destination so the caller can abort. Used for both cold storage and the
      // local models dir.
      const copyToDir = async (
        file: string,
        destBaseDir: string,
      ): Promise<boolean> => {
        const dst = nodePath.resolve(destBaseDir, file);
        if (!dst.startsWith(destBaseDir + nodePath.sep)) return false;
        await fsp.mkdir(nodePath.dirname(dst), {recursive: true});

        let nextEmitAt = EMIT_INTERVAL;
        const counter = makeCounter((n) => {
          fileDone += n;
          bytesDone += n;
          if (fileDone >= nextEmitAt) {
            nextEmitAt = fileDone + EMIT_INTERVAL;
            emit();
          }
        });

        if (isPeerSource) {
          logger.info(`[copy] fetch ${file} from ${from} → ${destBaseDir}`);
          const res = await fetch(
            `http://${from}/api/v1/local-models/download?file=${encodeURIComponent(file)}`,
            {signal},
          );
          if (!res.ok || !res.body) return false;
          const contentLen = parseInt(
            res.headers.get('content-length') ?? '0',
            10,
          );
          fileTotal = fileSizeMap[file] ?? contentLen;
          fileDone = 0;
          emit();
          await pipeline(
            // @ts-expect-error – DOM ReadableStream vs Node ReadableStream type mismatch
            Readable.fromWeb(res.body),
            counter,
            createWriteStream(dst),
            {signal},
          );
        } else {
          const src = resolveLocal(sourceBasePath!, file)!;
          fileTotal = fileSizeMap[file] ?? 0;
          fileDone = 0;
          emit();
          await pipeline(
            createReadStream(src),
            counter,
            createWriteStream(dst),
            {
              signal,
            },
          );
        }

        filesDone++;
        fileDone = fileTotal;
        emit();
        return true;
      };

      try {
        // ── Copy to cold storage ──────────────────────────────────────────
        if (toColdStorage) {
          for (const file of files) {
            if (shouldSkip(file, 'cold-storage')) continue;
            if (!(await copyToDir(file, coldBase))) {
              safeClose();
              return;
            }
          }
        }

        // ── Copy to peers (the local peer is just another address here) ────
        for (const peerAddr of toPeers) {
          if (peerAddr === localPeerAddr) {
            // Local-peer destination: copy straight into local storage. The
            // copyToDir helper handles both a peer source (download) and a
            // local/cold source (direct read).
            for (const file of files) {
              if (shouldSkip(file, peerAddr)) continue;
              if (!(await copyToDir(file, localBase))) {
                safeClose();
                return;
              }
            }
          } else if (isPeerSource) {
            // Tell the source peer to push directly — no per-byte visibility
            // here, so report the whole file in one step.
            const nonSkippedFiles = files.filter(
              (f) => !shouldSkip(f, peerAddr),
            );
            if (nonSkippedFiles.length === 0) continue;
            const pushBytes = nonSkippedFiles.reduce(
              (s, f) => s + (fileSizeMap[f] ?? 0),
              0,
            );
            fileTotal = pushBytes;
            fileDone = 0;
            emit();

            logger.info(
              `[copy] push ${nonSkippedFiles.length} file(s) from ${from} → ${peerAddr}`,
            );
            const res = await fetch(`http://${from}/api/v1/local-models/push`, {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({files: nonSkippedFiles, toPeer: peerAddr}),
              signal,
            });
            if (!res.ok) {
              safeClose();
              return;
            }

            filesDone++;
            bytesDone += pushBytes;
            fileDone = pushBytes;
            emit();
          } else if (from === 'cold-storage' && peerAddr !== localPeerAddr) {
            // Tell the remote peer to copy from its own cold storage, streaming
            // progress back rather than routing bytes through this host.
            const nonSkippedFiles = files.filter(
              (f) => !shouldSkip(f, peerAddr),
            );
            if (nonSkippedFiles.length > 0) {
              const peerBytes = nonSkippedFiles.reduce(
                (s, f) => s + (fileSizeMap[f] ?? 0),
                0,
              );
              fileTotal = peerBytes;
              fileDone = 0;
              emit();

              logger.info(
                `[copy] cold→local ${nonSkippedFiles.length} file(s) → ${peerAddr}`,
              );
              const res = await fetch(
                `http://${peerAddr}/api/v1/cold-storage/to-local`,
                {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({files: nonSkippedFiles}),
                  signal,
                },
              );
              if (!res.ok || !res.body) {
                logger.error(
                  `[copy] cold→local failed for ${peerAddr}: ${res.status}`,
                );
                safeClose();
                return;
              }

              const reader = res.body.getReader();
              const dec = new TextDecoder();
              let buf = '';
              const baseBytesDone = bytesDone;
              const baseFilesDone = filesDone;
              for (;;) {
                const {done, value} = await reader.read();
                if (done) break;
                buf += dec.decode(value, {stream: true});
                const lines = buf.split('\n');
                buf = lines.pop() ?? '';
                for (const line of lines) {
                  if (!line.trim()) continue;
                  const p = JSON.parse(line) as {
                    bytesDone: number;
                    filesDone: number;
                  };
                  fileDone = p.bytesDone;
                  bytesDone = baseBytesDone + p.bytesDone;
                  filesDone = baseFilesDone + p.filesDone;
                  emit();
                }
              }
            }
          } else {
            for (const file of files) {
              if (shouldSkip(file, peerAddr)) continue;
              const uploadUrl = `http://${peerAddr}/api/v1/local-models/upload`;
              const src = resolveLocal(sourceBasePath!, file)!;
              const fileSize = fileSizeMap[file] ?? 0;
              fileTotal = fileSize;
              fileDone = 0;
              emit();

              logger.info(`[copy] upload ${file} → ${peerAddr}`);
              if (fileSize === 0) {
                await fetch(uploadUrl, {
                  method: 'POST',
                  headers: {'x-file-path': file, 'x-chunk-offset': '0'},
                  signal,
                });
              } else {
                for (let offset = 0; offset < fileSize; offset += CHUNK_SIZE) {
                  signal.throwIfAborted();
                  const chunkEnd = Math.min(offset + CHUNK_SIZE, fileSize);
                  logger.debug(
                    `[copy] upload chunk ${file} offset=${offset} → ${peerAddr}`,
                  );
                  const readable = createReadStream(src, {
                    start: offset,
                    end: chunkEnd - 1,
                  });
                  await fetch(uploadUrl, {
                    method: 'POST',
                    headers: {
                      'x-file-path': file,
                      'x-chunk-offset': String(offset),
                      'Content-Type': 'application/octet-stream',
                    },
                    body: Readable.toWeb(readable) as unknown as BodyInit,
                    // @ts-expect-error – duplex required for streaming request bodies in Node fetch
                    duplex: 'half',
                    signal,
                  });
                  fileDone = chunkEnd;
                  bytesDone += chunkEnd - offset;
                  emit();
                }
              }

              filesDone++;
              fileDone = fileSize;
              emit();
            }
          }
        }

        // ── Delete source after successful copy to cold storage ───────────
        if (deleteAfterCopy && toColdStorage) {
          const filesToDelete = files.filter(
            (f) => !shouldSkip(f, 'cold-storage'),
          );
          if (filesToDelete.length > 0) {
            if (isPeerSource) {
              logger.info(
                `[copy] delete ${filesToDelete.length} file(s) from ${from}`,
              );
              await fetch(`http://${from}/api/v1/local-models`, {
                method: 'DELETE',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({files: filesToDelete}),
              });
            } else {
              for (const file of filesToDelete) {
                await fsp.rm(resolveLocal(sourceBasePath!, file)!, {
                  force: true,
                });
              }
            }
          }
        }

        logger.info(`[copy] done: ${files.length} file(s) from ${from}`);
        safeClose();
      } catch (err) {
        if (signal.aborted) {
          logger.info(`[copy] cancelled: ${files.length} file(s) from ${from}`);
        } else {
          logger.error(
            `[copy] error: ${files.length} file(s) from ${from}:`,
            err,
          );
        }
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
