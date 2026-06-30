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

  if (!req.body) return new Response('No body', {status: 400});

  await fsp.mkdir(nodePath.dirname(full), {recursive: true});
  const writer = createWriteStream(full);
  // @ts-expect-error – DOM ReadableStream vs Node ReadableStream type mismatch
  await pipeline(Readable.fromWeb(req.body), writer);

  return Response.json({ok: true});
}
