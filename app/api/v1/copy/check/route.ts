import {localModelsDir, coldStorageDir, localPeer} from '@/lib/config';
import {expandSupportFiles} from '@/lib/storage/support-files';
import {recordedSha256} from '@/lib/storage/recorded-digest';
import {logger} from '@/lib/util/logger';
import {isObject, isStringArray, readJsonBody} from '@/lib/util/request';
import nodePath from 'path';
import {promises as fsp} from 'fs';
import {execFile} from 'child_process';
import {promisify} from 'util';

const execFileP = promisify(execFile);

type SourceFile = {path: string; from: string; size: number};

async function localMd5(fullPath: string): Promise<string> {
  const {stdout} = await execFileP('md5sum', [fullPath]);
  return stdout.split(/\s+/)[0];
}

async function peerChecksumData(
  peerAddr: string,
  file: string,
): Promise<{size: number; md5: string} | null> {
  try {
    const res = await fetch(
      `http://${peerAddr}/api/v1/local-models/checksum?file=${encodeURIComponent(file)}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as {size: number; md5: string};
  } catch {
    return null;
  }
}

// The SHA256 a peer's sidecar already recorded for a file, without asking it
// to hash anything. null when it has no usable record — or when it predates
// the `recorded` parameter and answered with an md5 instead.
async function peerRecordedSha256(
  peerAddr: string,
  file: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `http://${peerAddr}/api/v1/local-models/checksum?file=${encodeURIComponent(file)}&recorded=1`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {sha256?: string | null};
    return data.sha256 ?? null;
  } catch {
    return null;
  }
}

// Compare each selected file against what already exists at each destination
// (cold storage and/or peers), reporting size and digest matches so the UI can
// let the user choose what to overwrite before any bytes move.
//
// Streams newline-delimited JSON: a `progress` frame per file/destination pair
// examined, then one `result` frame carrying the conflicts and the expanded
// file list. Hashing a large model reads every byte through the slowest disk
// involved, so the client needs to see (and be able to abandon) the wait.
//
// Digests come from the sidecars whenever both copies still match their
// recorded size and predate their sidecar — `tjmodel.json` already holds the
// SHA256 computed at download time, so the common "already there, unchanged"
// case reads no file bytes at all. Only when a side has no trustworthy record
// does this fall back to md5-ing both copies.
export async function POST(req: Request) {
  const body = await readJsonBody<{
    files: SourceFile[];
    toColdStorage: boolean;
    toPeers: string[];
  }>(req, isObject);
  if (body instanceof Response) return body;

  const {files, toColdStorage, toPeers} = body;
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
  if (!isStringArray(toPeers)) {
    return new Response('Invalid toPeers', {status: 400});
  }
  const localPeerAddr = localPeer?.address ?? '';
  const localBase = localModelsDir ? nodePath.resolve(localModelsDir) : '';
  const coldBase = coldStorageDir ? nodePath.resolve(coldStorageDir) : '';

  // Expand each source's weight files with the support files sitting in the
  // same model directories (config.json, tokenizer files, a safetensors
  // index): the weight scan — and so the selection — only tracks weight
  // files, and a whole-repo model copied without its support files can't be
  // loaded. The expanded list is both conflict-checked below and returned,
  // so the client sends the same list to /api/v1/copy. Best effort per
  // source: an unreachable peer (or one predating this endpoint) expands to
  // nothing and the copy proceeds as selected.
  const byFrom = new Map<string, SourceFile[]>();
  for (const f of files) {
    if (!byFrom.has(f.from)) byFrom.set(f.from, []);
    byFrom.get(f.from)!.push(f);
  }
  const knownPaths = new Set(files.map((f) => f.path));
  const expandedFiles: SourceFile[] = [...files];
  for (const [from, group] of byFrom) {
    const paths = group.map((f) => f.path);
    let extra: Array<{path: string; size: number}> = [];
    try {
      if (from === 'cold-storage') {
        if (coldBase) extra = await expandSupportFiles(coldBase, paths);
      } else if (from === localPeerAddr) {
        if (localBase) extra = await expandSupportFiles(localBase, paths);
      } else {
        const res = await fetch(
          `http://${from}/api/v1/local-models/support-files`,
          {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({files: paths}),
          },
        );
        if (res.ok)
          extra = ((await res.json()) as {files: typeof extra}).files ?? [];
      }
    } catch (e) {
      logger.warn(
        `[check] support-file expansion failed for ${from}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    for (const f of extra) {
      if (typeof f?.path !== 'string' || typeof f?.size !== 'number') continue;
      if (knownPaths.has(f.path)) continue;
      knownPaths.add(f.path);
      expandedFiles.push({path: f.path, from, size: f.size});
    }
  }

  const conflicts: Array<{
    file: string;
    destination: string;
    sourceSize: number;
    destSize: number;
    sizeMatch: boolean;
    digest: 'sha256' | 'md5' | null;
    digestMatch: boolean | null;
    sourceDigest: string | null;
    destDigest: string | null;
  }> = [];

  const destinations = [...(toColdStorage ? ['cold-storage'] : []), ...toPeers];
  // The progress denominator: a file is never compared against the place it is
  // being copied from, so those pairs don't count.
  const pairsTotal = expandedFiles.reduce(
    (n, f) => n + destinations.filter((d) => d !== f.from).length,
    0,
  );

  const enc = new TextEncoder();
  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();

  // Examine the pairs in the background; the response streams `readable`.
  (async () => {
    let closed = false;
    const write = async (frame: unknown) => {
      if (closed) return;
      try {
        await writer.ready;
        await writer.write(enc.encode(JSON.stringify(frame) + '\n'));
      } catch {
        closed = true;
      }
    };
    let pairsDone = 0;

    for (const f of expandedFiles) {
      // A client that navigated away or hit Cancel: stop before starting the
      // next file rather than hashing on for nobody.
      if (req.signal.aborted) break;
      try {
        const {path: file, from, size: sourceSize} = f;

        // Both digests for a side, resolved lazily and cached per file: the
        // recorded one costs a sidecar read (or a peer request), the md5 costs
        // a full read of the file.
        let sourceRecordedCache: string | null | undefined = undefined;
        const getSourceRecorded = async (): Promise<string | null> => {
          if (sourceRecordedCache !== undefined) return sourceRecordedCache;
          let result: string | null;
          if (from === 'cold-storage') {
            result = coldBase ? await recordedSha256(coldBase, file) : null;
          } else if (from === localPeerAddr) {
            result = localBase ? await recordedSha256(localBase, file) : null;
          } else {
            result = await peerRecordedSha256(from, file);
          }
          sourceRecordedCache = result;
          return result;
        };

        let sourceMd5Cache: string | null | undefined = undefined;
        const getSourceMd5 = async (): Promise<string | null> => {
          if (sourceMd5Cache !== undefined) return sourceMd5Cache;
          let result: string | null;
          if (from === 'cold-storage') {
            try {
              result = await localMd5(nodePath.resolve(coldBase, file));
            } catch {
              result = null;
            }
          } else if (from === localPeerAddr) {
            try {
              result = await localMd5(nodePath.resolve(localBase, file));
            } catch {
              result = null;
            }
          } else {
            const cs = await peerChecksumData(from, file);
            result = cs?.md5 ?? null;
          }
          sourceMd5Cache = result;
          return result;
        };

        for (const destination of destinations) {
          if (destination === from) continue;
          if (req.signal.aborted) break;

          let destSize: number | null = null;
          let destRecordedFn: () => Promise<string | null>;
          let destMd5Fn: () => Promise<string | null>;

          if (destination === 'cold-storage') {
            const destPath = nodePath.resolve(coldBase, file);
            if (!destPath.startsWith(coldBase + nodePath.sep)) continue;
            try {
              destSize = (await fsp.stat(destPath)).size;
            } catch {
              continue;
            }
            destRecordedFn = () => recordedSha256(coldBase, file);
            destMd5Fn = async () => {
              try {
                return await localMd5(destPath);
              } catch {
                return null;
              }
            };
          } else if (destination === localPeerAddr) {
            const destPath = nodePath.resolve(localBase, file);
            if (!destPath.startsWith(localBase + nodePath.sep)) continue;
            try {
              destSize = (await fsp.stat(destPath)).size;
            } catch {
              continue;
            }
            destRecordedFn = () => recordedSha256(localBase, file);
            destMd5Fn = async () => {
              try {
                return await localMd5(destPath);
              } catch {
                return null;
              }
            };
          } else {
            try {
              const headRes = await fetch(
                `http://${destination}/api/v1/local-models/download?file=${encodeURIComponent(file)}`,
                {method: 'HEAD'},
              );
              if (!headRes.ok) continue;
              destSize = parseInt(
                headRes.headers.get('content-length') ?? '0',
                10,
              );
            } catch {
              continue;
            }
            destRecordedFn = () => peerRecordedSha256(destination, file);
            destMd5Fn = async () => {
              const cs = await peerChecksumData(destination, file);
              return cs?.md5 ?? null;
            };
          }

          const sizeMatch = sourceSize === destSize;
          let digest: 'sha256' | 'md5' | null = null;
          let digestMatch: boolean | null = null;
          let sourceDigest: string | null = null;
          let destDigest: string | null = null;

          if (sizeMatch) {
            // Differing sizes already answer the question, so only same-size
            // pairs need a digest. Try the recorded SHA256s first — both sides
            // answer from their sidecars without reading a byte.
            const [srcSha, dstSha] = await Promise.all([
              getSourceRecorded(),
              destRecordedFn(),
            ]);
            if (srcSha && dstSha) {
              digest = 'sha256';
              sourceDigest = srcSha;
              destDigest = dstSha;
              digestMatch = srcSha === dstSha;
            } else {
              await write({
                type: 'progress',
                done: pairsDone,
                total: pairsTotal,
                file,
                hashing: true,
              });
              [sourceDigest, destDigest] = await Promise.all([
                getSourceMd5(),
                destMd5Fn(),
              ]);
              if (sourceDigest !== null && destDigest !== null) {
                digest = 'md5';
                digestMatch = sourceDigest === destDigest;
              }
            }
          }

          conflicts.push({
            file,
            destination,
            sourceSize,
            destSize: destSize ?? 0,
            sizeMatch,
            digest,
            digestMatch,
            sourceDigest,
            destDigest,
          });
          pairsDone++;
          await write({
            type: 'progress',
            done: pairsDone,
            total: pairsTotal,
            file,
            hashing: false,
          });
        }
      } catch {
        logger.debug(`[check] skipping file ${f.path}: not present`);
      }
    }

    if (!req.signal.aborted) {
      await write({type: 'result', conflicts, files: expandedFiles});
    }
    if (!closed) {
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
    },
  });
}
