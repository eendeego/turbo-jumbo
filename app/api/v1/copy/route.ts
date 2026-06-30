import {localModelsDir, coldStorageDir} from '@/lib/config';
import {promises as fsp} from 'fs';
import {createReadStream, createWriteStream} from 'fs';
import nodePath from 'path';
import {pipeline} from 'stream/promises';
import {Readable} from 'stream';

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB

type CopyRequest = {
  files: string[];
  from: string; // "local" | "cold-storage" | peer address
  toColdStorage: boolean;
  toPeers: string[];
  deleteAfterCopy: boolean;
};

function resolveLocal(basePath: string, file: string): string | null {
  const base = nodePath.resolve(basePath);
  const full = nodePath.resolve(base, file);
  return full.startsWith(base + nodePath.sep) ? full : null;
}

export async function POST(req: Request) {
  const body = (await req.json()) as CopyRequest;
  const {files, from, toColdStorage, toPeers, deleteAfterCopy} = body;

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

  const coldOps = toColdStorage ? files.length : 0;
  const peerOps = toPeers.length * (isPeerSource ? 1 : files.length);
  const total = coldOps + peerOps;

  const enc = new TextEncoder();

  // Stream newline-delimited progress so the browser can render a live bar.
  const stream = new ReadableStream({
    async start(controller) {
      let done = 0;
      const progress = () => {
        done++;
        controller.enqueue(enc.encode(JSON.stringify({done, total}) + '\n'));
      };

      // Send an initial event so the client learns the total immediately.
      controller.enqueue(enc.encode(JSON.stringify({done: 0, total}) + '\n'));

      try {
        // Copy to cold storage
        if (toColdStorage) {
          for (const file of files) {
            const dst = nodePath.resolve(coldBase, file);
            if (!dst.startsWith(coldBase + nodePath.sep)) {
              controller.close();
              return;
            }
            await fsp.mkdir(nodePath.dirname(dst), {recursive: true});

            if (isPeerSource) {
              const res = await fetch(
                `http://${from}/api/v1/local-models/download?file=${encodeURIComponent(file)}`,
              );
              if (!res.ok || !res.body) {
                controller.close();
                return;
              }
              const writer = createWriteStream(dst);
              // @ts-expect-error – DOM ReadableStream vs Node ReadableStream type mismatch
              await pipeline(Readable.fromWeb(res.body), writer);
            } else {
              const src = resolveLocal(sourceBasePath!, file)!;
              await fsp.copyFile(src, dst);
            }
            progress();
          }
        }

        // Copy to peers
        for (const peerAddr of toPeers) {
          if (isPeerSource) {
            // Tell the source peer to push files directly to the destination
            // peer, avoiding routing the data through this server.
            const res = await fetch(`http://${from}/api/v1/local-models/push`, {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({files, toPeer: peerAddr}),
            });
            if (!res.ok) {
              controller.close();
              return;
            }
            progress();
          } else {
            for (const file of files) {
              const uploadUrl = `http://${peerAddr}/api/v1/local-models/upload`;
              const src = resolveLocal(sourceBasePath!, file)!;
              const {size: fileSize} = await fsp.stat(src);

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
                }
              }
              progress();
            }
          }
        }

        // Delete source after successful copy to cold storage
        if (deleteAfterCopy && toColdStorage) {
          if (isPeerSource) {
            await fetch(`http://${from}/api/v1/local-models`, {
              method: 'DELETE',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({files}),
            });
          } else {
            for (const file of files) {
              const full = resolveLocal(sourceBasePath!, file)!;
              await fsp.rm(full, {force: true});
            }
          }
        }

        controller.close();
      } catch {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {'Content-Type': 'application/x-ndjson'},
  });
}
