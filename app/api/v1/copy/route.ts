import {resumeOffset} from '@/lib/audit';
import {localModelsDir, coldStorageDir, localPeer} from '@/lib/config';
import {logger} from '@/lib/logger';
import {promises as fsp} from 'fs';
import {createReadStream, createWriteStream} from 'fs';
import nodePath from 'path';
import {pipeline} from 'stream/promises';
import {Readable, Transform} from 'stream';

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB
// Emit a progress event at most once per this many streamed bytes.
const EMIT_INTERVAL = 512 * 1024; // 512 KB — frequent enough for per-file progress visibility

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
  // disconnect in Next.js/Bun, aborting the background copy loop.
  req.signal.addEventListener('abort', () => abortController.abort(), {
    once: true,
  });

  // Stream newline-delimited progress so the browser can render a live bar.
  // A TransformStream lets us await each write (back-pressure aware), which
  // guarantees the initial event flushes to the client instead of buffering.
  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();

  // Run the copy work in the background; the response streams `readable`.
  (async () => {
    const {signal} = abortController;
    let closed = false;
    const safeWrite = async (data: Uint8Array) => {
      if (closed) return;
      try {
        await writer.ready;
        await writer.write(data);
      } catch {
        closed = true;
        abortController.abort();
      }
    };
    const safeClose = async () => {
      if (!closed) {
        closed = true;
        try {
          await writer.close();
        } catch {
          /* already closed */
        }
      }
    };

    let filesDone = 0;
    let bytesDone = 0;
    let fileDone = 0;
    let fileTotal = 0;
    // Pre-copy verification state for the current file: while a partial
    // destination is being hash-compared against the source, phase is
    // 'verifying' and verifyDone/verifyTotal track the hashing; afterwards
    // `resume` records the outcome ('resumed' = prefix matched, 'from-start' =
    // SHA256 mismatch, null = no partial was found).
    let phase: 'verifying' | 'copying' = 'copying';
    let verifyDone = 0;
    let verifyTotal = 0;
    let resume: 'resumed' | 'from-start' | null = null;
    const resetFilePhase = () => {
      phase = 'copying';
      verifyDone = 0;
      verifyTotal = 0;
      resume = null;
    };

    const emit = () =>
      safeWrite(
        enc.encode(
          JSON.stringify({
            filesDone,
            filesTotal,
            fileDone,
            fileTotal,
            bytesDone,
            bytesTotal,
            phase,
            verifyDone,
            verifyTotal,
            resume,
          }) + '\n',
        ),
      );

    await emit(); // initial event — awaiting write ensures the client receives it

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
        resetFilePhase();
        phase = 'verifying';
        emit();

        // Resume an interrupted earlier copy: skip the prefix already at the
        // destination when it hash-matches the source's same region.
        let verified = false;
        let nextVerifyEmit = 0;
        const offset = await resumeOffset(src, dst, (done, total) => {
          verified = true;
          verifyDone = done;
          verifyTotal = total;
          if (done >= nextVerifyEmit) {
            nextVerifyEmit = done + EMIT_INTERVAL;
            emit();
          }
        });
        phase = 'copying';
        if (verified) {
          resume = offset > 0 ? 'resumed' : 'from-start';
          emit();
        }
        if (offset > 0) {
          fileDone = offset;
          bytesDone += offset;
          emit();
        }
        if (offset === 0 || offset < fileTotal) {
          let nextEmitAt = fileDone + EMIT_INTERVAL;
          const resumeCounter = makeCounter((n) => {
            fileDone += n;
            bytesDone += n;
            if (fileDone >= nextEmitAt) {
              nextEmitAt = fileDone + EMIT_INTERVAL;
              emit();
            }
          });
          await pipeline(
            createReadStream(src, {start: offset}),
            resumeCounter,
            createWriteStream(dst, offset > 0 ? {flags: 'a'} : {}),
            {signal},
          );
        }
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
      resetFilePhase(); // don't carry a cold-storage resume label into peer copies
      for (const peerAddr of toPeers) {
        if (isPeerSource) {
          if (peerAddr === localPeerAddr) {
            // Remote source → local destination: download each file.
            for (const file of files) {
              if (shouldSkip(file, peerAddr)) continue;
              if (!(await copyToDir(file, localBase))) {
                safeClose();
                return;
              }
            }
          } else {
            // Remote source → remote destination: tell the source peer to
            // push directly — no per-byte visibility, so report in one step.
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
              body: JSON.stringify({
                files: nonSkippedFiles,
                toPeer: peerAddr,
              }),
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
          }
        } else if (peerAddr !== localPeerAddr) {
          // Local/cold source → remote destination.
          const nonSkippedFiles = files.filter((f) => !shouldSkip(f, peerAddr));
          if (nonSkippedFiles.length === 0) continue;

          // If the source is cold storage — or the files only exist in cold
          // storage, not locally — have the remote peer copy from its own
          // cold storage instead of uploading bytes through this host.
          let allInCold = from === 'cold-storage';
          if (!allInCold) {
            allInCold = true;
            for (const f of nonSkippedFiles) {
              const local = resolveLocal(localBase, f);
              if (!local) continue;
              try {
                await fsp.access(local);
                allInCold = false;
                break;
              } catch {
                /* not present locally */
              }
            }
          }

          if (allInCold) {
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
          } else {
            // Upload from our local source to the remote peer.
            for (const file of nonSkippedFiles) {
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
        } else {
          // Local destination: copy each file, trying the source base first,
          // then falling back to cold storage.
          for (const file of files) {
            if (shouldSkip(file, peerAddr)) continue;
            const dst = resolveLocal(localBase, file);
            if (!dst) {
              logger.error(`[copy] invalid dst path: ${file}`);
              continue;
            }

            let src = sourceBasePath
              ? resolveLocal(sourceBasePath, file)
              : null;
            if (src) {
              try {
                await fsp.access(src);
              } catch {
                src = null;
              }
            }
            if (!src) {
              src = resolveLocal(coldBase, file);
              if (src) {
                try {
                  await fsp.access(src);
                } catch {
                  src = null;
                }
              }
            }
            if (!src) {
              logger.error(`[copy] file not found in local or cold: ${file}`);
              continue;
            }

            await fsp.mkdir(nodePath.dirname(dst), {recursive: true});
            fileTotal = fileSizeMap[file] ?? 0;
            fileDone = 0;
            emit();
            await new Promise((r) => setTimeout(r, 0));

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
      await safeClose();
    } catch (err) {
      if (signal.aborted) {
        logger.info(`[copy] cancelled: ${files.length} file(s) from ${from}`);
      } else {
        logger.error(
          `[copy] error: ${files.length} file(s) from ${from}:`,
          err,
        );
      }
      await safeClose();
    }
  })();

  return new Response(readable, {
    headers: {'Content-Type': 'application/x-ndjson'},
  });
}
