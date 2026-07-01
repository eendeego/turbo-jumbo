import {streamCopyResumable} from '@/lib/audit';
import {config, localModelsDir, coldStorageDir, localPeer} from '@/lib/config';
import {logger} from '@/lib/logger';
import {isObject, readJsonBody} from '@/lib/request';
import {promises as fsp} from 'fs';
import {createReadStream, createWriteStream} from 'fs';
import nodePath from 'path';
import {pipeline} from 'stream/promises';
import {Readable, Transform} from 'stream';

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB
// Emit a progress event at most once per this many streamed bytes.
const EMIT_INTERVAL = 512 * 1024; // 512 KB — frequent enough for per-file progress visibility

type SourceFile = {
  path: string;
  from: string; // "cold-storage" | peer address (may be the local peer's own address)
  size: number;
};

type CopyRequest = {
  files: SourceFile[];
  toColdStorage: boolean;
  toPeers: string[]; // peer addresses (may include the local peer's address)
  deleteAfterCopy: boolean;
  skip?: Array<{file: string; destination: string}>;
};

function resolveWithin(base: string, file: string): string | null {
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
  const parsed = await readJsonBody<CopyRequest>(req, isObject);
  if (parsed instanceof Response) return parsed;
  const body = parsed;
  const {files, toColdStorage, toPeers, deleteAfterCopy} = body;

  if (
    !Array.isArray(files) ||
    files.some(
      (f) =>
        typeof f?.path !== 'string' ||
        typeof f?.from !== 'string' ||
        typeof f?.size !== 'number',
    )
  ) {
    return new Response('Invalid files', {status: 400});
  }

  // file+destination pairs the user chose not to overwrite (see /api/v1/copy/check).
  const skipSet = new Set(
    (body.skip ?? []).map((s) => `${s.file}\0${s.destination}`),
  );
  const shouldSkip = (file: string, dest: string) =>
    skipSet.has(`${file}\0${dest}`);

  // The local peer is just another peer address; "from"/"toPeers" use it for
  // local source/destination instead of a special "local" token.
  const localPeerAddr = localPeer?.address ?? '';

  if (toColdStorage && !coldStorageDir)
    return new Response('No cold storage configured', {status: 400});

  const coldBase = coldStorageDir ? nodePath.resolve(coldStorageDir) : '';
  const localBase = localModelsDir ? nodePath.resolve(localModelsDir) : '';

  // Every host we'll talk to comes from the request body (`toPeers`, and each
  // file's `from`), and we fetch `http://<host>/...` against it — so confine
  // them to configured peers. Otherwise a caller could aim the server at an
  // arbitrary host, and the local-source branch would stream local files there.
  const knownPeers = new Set(config.peers.map((p) => p.address));
  if (
    !Array.isArray(toPeers) ||
    toPeers.some((p) => typeof p !== 'string' || !knownPeers.has(p))
  ) {
    return new Response('Unknown peer', {status: 400});
  }
  if (files.some((f) => f.from !== 'cold-storage' && !knownPeers.has(f.from))) {
    return new Response('Unknown source', {status: 400});
  }

  // Validate local-source paths up-front.
  for (const f of files) {
    if (f.from === 'cold-storage') {
      if (!resolveWithin(coldBase, f.path))
        return new Response('Invalid path', {status: 400});
    } else if (f.from === localPeerAddr) {
      if (!resolveWithin(localBase, f.path))
        return new Response('Invalid path', {status: 400});
    }
  }

  const destinations = [...(toColdStorage ? ['cold-storage'] : []), ...toPeers];

  let filesTotal = 0;
  let bytesTotal = 0;
  for (const f of files) {
    for (const dest of destinations) {
      if (dest === f.from || shouldSkip(f.path, dest)) continue;
      filesTotal++;
      bytesTotal += f.size;
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

    // Per-(file, destination) failures are collected rather than aborting the
    // whole run: one unreachable peer or unreadable file shouldn't cancel the
    // copies to other destinations. They ride along in every progress frame's
    // `errors`, and the client surfaces them once the stream ends. Only a
    // client disconnect (signal.aborted) tears the whole stream down.
    const errors: string[] = [];

    // Files that reached cold storage (copied this run, or already there and
    // skipped), so the post-copy delete only removes sources that are safe.
    const coldDone = new Set<string>();

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
            errors,
          }) + '\n',
        ),
      );

    const fail = (where: string, message: string) => {
      logger.error(`[copy] ${where}: ${message}`);
      errors.push(`${where}: ${message}`);
      emit();
    };

    await emit(); // initial event — awaited so the client receives the opening frame

    logger.info(
      `[copy] start: ${files.length} file(s) → ${destinations.join(', ') || '(no destinations)'}`,
    );

    try {
      // Per-destination, group files by their source so peer→peer pushes can batch.
      for (const dest of destinations) {
        const bySource = new Map<string, SourceFile[]>();
        for (const f of files) {
          if (f.from === dest || shouldSkip(f.path, dest)) continue;
          if (!bySource.has(f.from)) bySource.set(f.from, []);
          bySource.get(f.from)!.push(f);
        }

        const destIsCold = dest === 'cold-storage';
        const destIsLocalPeer = dest === localPeerAddr;
        const destIsRemote = !destIsCold && !destIsLocalPeer;

        for (const [source, groupFiles] of bySource) {
          const srcIsCold = source === 'cold-storage';
          const srcIsLocalPeer = source === localPeerAddr;
          const srcIsRemote = !srcIsCold && !srcIsLocalPeer;

          // Remote dest, remote source, different peers → batched push via source
          if (destIsRemote && srcIsRemote) {
            const pushBytes = groupFiles.reduce((s, f) => s + f.size, 0);
            fileTotal = pushBytes;
            fileDone = 0;
            resetFilePhase();
            emit();

            logger.info(
              `[copy] push ${groupFiles.length} file(s) from ${source} → ${dest}`,
            );
            const res = await fetch(
              `http://${source}/api/v1/local-models/push`,
              {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                  files: groupFiles.map((f) => f.path),
                  toPeer: dest,
                }),
                signal,
              },
            );
            if (!res.ok) {
              fail(`push ${source} → ${dest}`, `HTTP ${res.status}`);
              continue;
            }
            filesDone += groupFiles.length;
            bytesDone += pushBytes;
            fileDone = pushBytes;
            emit();
            continue;
          }

          // Remote dest, cold source → ask dest to copy from its own cold storage.
          // (Assumes cold storage is shared/mounted identically across peers.)
          if (destIsRemote && srcIsCold) {
            const totalBytes = groupFiles.reduce((s, f) => s + f.size, 0);
            fileTotal = totalBytes;
            fileDone = 0;
            resetFilePhase();
            emit();

            logger.info(
              `[copy] cold→local ${groupFiles.length} file(s) → ${dest}`,
            );
            const res = await fetch(
              `http://${dest}/api/v1/cold-storage/to-local`,
              {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({files: groupFiles.map((f) => f.path)}),
                signal,
              },
            );
            if (!res.ok || !res.body) {
              fail(`cold→local → ${dest}`, `HTTP ${res.status}`);
              continue;
            }
            // Stream progress from the remote peer.
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            const baseBytesDone = bytesDone;
            const baseFilesDone = filesDone;
            try {
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
            } catch (err) {
              if (signal.aborted) throw err;
              fail(
                `cold→local → ${dest}`,
                err instanceof Error ? err.message : String(err),
              );
            }
            continue;
          }

          // Remote dest, local source → upload each file chunked.
          if (destIsRemote && srcIsLocalPeer) {
            for (const f of groupFiles) {
              const src = resolveWithin(localBase, f.path)!;
              fileTotal = f.size;
              fileDone = 0;
              resetFilePhase();
              emit();

              try {
                logger.info(`[copy] upload ${f.path} → ${dest}`);
                const uploadUrl = `http://${dest}/api/v1/local-models/upload`;
                if (f.size === 0) {
                  const res = await fetch(uploadUrl, {
                    method: 'POST',
                    headers: {'x-file-path': f.path, 'x-chunk-offset': '0'},
                    signal,
                  });
                  if (!res.ok) throw new Error(`HTTP ${res.status}`);
                } else {
                  for (let offset = 0; offset < f.size; offset += CHUNK_SIZE) {
                    signal.throwIfAborted();
                    const chunkEnd = Math.min(offset + CHUNK_SIZE, f.size);
                    const readable = createReadStream(src, {
                      start: offset,
                      end: chunkEnd - 1,
                    });
                    const res = await fetch(uploadUrl, {
                      method: 'POST',
                      headers: {
                        'x-file-path': f.path,
                        'x-chunk-offset': String(offset),
                        'Content-Type': 'application/octet-stream',
                      },
                      body: Readable.toWeb(readable) as unknown as BodyInit,
                      // @ts-expect-error – duplex required for streaming request bodies in Node fetch
                      duplex: 'half',
                      signal,
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    fileDone = chunkEnd;
                    bytesDone += chunkEnd - offset;
                    emit();
                  }
                }
                filesDone++;
                fileDone = f.size;
                emit();
              } catch (err) {
                if (signal.aborted) throw err;
                fail(
                  `upload ${f.path} → ${dest}`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            }
            continue;
          }

          // Remaining cases write to this machine (cold storage or local peer).
          const destBase = destIsCold ? coldBase : localBase;
          for (const f of groupFiles) {
            const dst = resolveWithin(destBase, f.path);
            if (!dst) {
              fail(`${source} → ${dest}: ${f.path}`, 'invalid dest path');
              continue;
            }

            try {
              await fsp.mkdir(nodePath.dirname(dst), {recursive: true});

              fileTotal = f.size;
              fileDone = 0;
              resetFilePhase();
              emit();
              await new Promise((r) => setTimeout(r, 0));

              if (srcIsCold || srcIsLocalPeer) {
                const srcBase = srcIsCold ? coldBase : localBase;
                const src = resolveWithin(srcBase, f.path)!;
                logger.info(`[copy] ${source} → ${dest}: ${f.path}`);

                // Resume an interrupted earlier copy: skip the prefix already
                // at the destination when it hash-matches the source's same
                // region. The shared core (also used by copyFileWithMeta) owns
                // the resume + stream; the hooks drive this route's phased
                // progress reporting.
                phase = 'verifying';
                emit();
                let verified = false;
                let nextVerifyEmit = 0;
                let nextEmitAt = 0;
                await streamCopyResumable(src, dst, {
                  signal,
                  onVerify: (done, total) => {
                    verified = true;
                    verifyDone = done;
                    verifyTotal = total;
                    if (done >= nextVerifyEmit) {
                      nextVerifyEmit = done + EMIT_INTERVAL;
                      emit();
                    }
                  },
                  onResume: (offset) => {
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
                    nextEmitAt = fileDone + EMIT_INTERVAL;
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
              } else {
                logger.info(`[copy] fetch ${f.path} from ${source} → ${dest}`);
                const res = await fetch(
                  `http://${source}/api/v1/local-models/download?file=${encodeURIComponent(f.path)}`,
                  {signal},
                );
                if (!res.ok || !res.body) {
                  throw new Error(`HTTP ${res.status}`);
                }
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
                  {signal},
                );
              }

              filesDone++;
              fileDone = f.size;
              if (destIsCold) coldDone.add(f.path);
              emit();
            } catch (err) {
              if (signal.aborted) throw err;
              fail(
                `${source} → ${dest}: ${f.path}`,
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }
      }

      // Delete sources after a successful cold-storage copy — but only files
      // that actually reached cold storage this run, so a failed copy never
      // takes its source with it. (Skipped files were already present at the
      // destination, hence excluded here.)
      if (deleteAfterCopy && toColdStorage) {
        const bySource = new Map<string, SourceFile[]>();
        for (const f of files) {
          if (f.from === 'cold-storage') continue;
          if (shouldSkip(f.path, 'cold-storage')) continue;
          if (!coldDone.has(f.path)) continue;
          if (!bySource.has(f.from)) bySource.set(f.from, []);
          bySource.get(f.from)!.push(f);
        }
        for (const [source, srcFiles] of bySource) {
          try {
            if (source === localPeerAddr) {
              for (const f of srcFiles) {
                await fsp.rm(resolveWithin(localBase, f.path)!, {force: true});
              }
            } else {
              logger.info(
                `[copy] delete ${srcFiles.length} file(s) from ${source}`,
              );
              const res = await fetch(`http://${source}/api/v1/local-models`, {
                method: 'DELETE',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({files: srcFiles.map((f) => f.path)}),
                signal,
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
            }
          } catch (err) {
            if (signal.aborted) throw err;
            fail(
              `delete from ${source}`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }

      logger.info(
        `[copy] done: ${files.length} file(s)${
          errors.length ? `, ${errors.length} failure(s)` : ''
        }`,
      );
      await emit(); // terminal frame — carries the final counters and full error list
      await safeClose();
    } catch (err) {
      if (signal.aborted) {
        logger.info(`[copy] cancelled: ${files.length} file(s)`);
      } else {
        logger.error(`[copy] error:`, err);
      }
      await safeClose();
    }
  })();

  return new Response(readable, {
    headers: {'Content-Type': 'application/x-ndjson'},
  });
}
