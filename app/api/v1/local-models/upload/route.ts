import {localModelsDir} from '@/lib/config';
import nodePath from 'path';
import {promises as fsp} from 'fs';
import {createWriteStream} from 'fs';
import {Readable} from 'stream';
import {pipeline} from 'stream/promises';

export async function POST(req: Request) {
  if (!localModelsDir) return new Response('No local peer', {status: 400});
  const filePath = req.headers.get('x-file-path');
  if (!filePath)
    return new Response('Missing x-file-path header', {status: 400});

  const base = nodePath.resolve(localModelsDir);
  const full = nodePath.resolve(base, filePath);
  if (!full.startsWith(base + nodePath.sep))
    return new Response('Invalid path', {status: 400});

  const offset = parseInt(req.headers.get('x-chunk-offset') ?? '0', 10);
  if (isNaN(offset) || offset < 0)
    return new Response('Invalid x-chunk-offset', {status: 400});

  await fsp.mkdir(nodePath.dirname(full), {recursive: true});

  if (!req.body) {
    // Empty file or missing body — create/truncate when this is the first chunk.
    if (offset === 0) await fsp.writeFile(full, new Uint8Array(0));
    return Response.json({ok: true});
  }

  // offset 0 truncates ('w'); later chunks append ('a' — O_APPEND atomically
  // seeks to EOF before each write, correct for sequential chunks).
  const writer = createWriteStream(
    full,
    offset === 0 ? undefined : {flags: 'a'},
  );
  // @ts-expect-error – DOM ReadableStream vs Node ReadableStream type mismatch
  await pipeline(Readable.fromWeb(req.body), writer);

  return Response.json({ok: true});
}
