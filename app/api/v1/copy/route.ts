import {localModelsDir, coldStorageDir} from '@/lib/config';
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
  from: string; // "local" | "cold-storage" | peer address
  toColdStorage: boolean;
  toPeers: string[];
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

  const isPeerSource = from !== 'local' && from !== 'cold-storage';
  const sourceBasePath =
    from === 'local'
      ? localModelsDir
      : from === 'cold-storage'
        ? coldStorageDir
        : null;

  if (!isPeerSource && !sourceBasePath)
    return new Response('No local peer configured', {status: 400});
  if (toColdStorage && !coldStorageDir)
    return new Response('No cold storage configured', {status: 400});

  const coldBase = coldStorageDir ? nodePath.resolve(coldStorageDir) : '';

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
      const {size} = await fsp.stat(resolveLocal(sourceBasePath, file)!);
      fileSizeMap[file] = size;
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
    if (isPeerSource) {
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

  // Stream newline-delimited progress so the browser can render a live bar.
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (data: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(data);
        } catch {
          closed = true;
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

      try {
        // ── Copy to cold storage ──────────────────────────────────────────
        if (toColdStorage) {
          for (const file of files) {
            if (shouldSkip(file, 'cold-storage')) continue;
            const dst = nodePath.resolve(coldBase, file);
            if (!dst.startsWith(coldBase + nodePath.sep)) {
              safeClose();
              return;
            }
            await fsp.mkdir(nodePath.dirname(dst), {recursive: true});

            if (isPeerSource) {
              const res = await fetch(
                `http://${from}/api/v1/local-models/download?file=${encodeURIComponent(file)}`,
              );
              if (!res.ok || !res.body) {
                safeClose();
                return;
              }

              const contentLen = parseInt(
                res.headers.get('content-length') ?? '0',
                10,
              );
              fileTotal = fileSizeMap[file] ?? contentLen;
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
                // @ts-expect-error – DOM ReadableStream vs Node ReadableStream type mismatch
                Readable.fromWeb(res.body),
                counter,
                createWriteStream(dst),
              );
            } else {
              const src = resolveLocal(sourceBasePath!, file)!;
              fileTotal = fileSizeMap[file] ?? 0;
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
              );
            }

            filesDone++;
            fileDone = fileTotal;
            emit();
          }
        }

        // ── Copy to peers ─────────────────────────────────────────────────
        for (const peerAddr of toPeers) {
          if (isPeerSource) {
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

            const res = await fetch(`http://${from}/api/v1/local-models/push`, {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({files: nonSkippedFiles, toPeer: peerAddr}),
            });
            if (!res.ok) {
              safeClose();
              return;
            }

            filesDone++;
            bytesDone += pushBytes;
            fileDone = pushBytes;
            emit();
          } else {
            for (const file of files) {
              if (shouldSkip(file, peerAddr)) continue;
              const uploadUrl = `http://${peerAddr}/api/v1/local-models/upload`;
              const src = resolveLocal(sourceBasePath!, file)!;
              const fileSize = fileSizeMap[file] ?? 0;
              fileTotal = fileSize;
              fileDone = 0;
              emit();

              if (fileSize === 0) {
                await fetch(uploadUrl, {
                  method: 'POST',
                  headers: {'x-file-path': file, 'x-chunk-offset': '0'},
                });
              } else {
                for (let offset = 0; offset < fileSize; offset += CHUNK_SIZE) {
                  const chunkEnd = Math.min(offset + CHUNK_SIZE, fileSize);
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

        safeClose();
      } catch {
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {'Content-Type': 'application/x-ndjson'},
  });
}
