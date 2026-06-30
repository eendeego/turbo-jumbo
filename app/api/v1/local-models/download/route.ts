import {localModelsDir} from '@/lib/config';
import nodePath from 'path';
import {promises as fsp} from 'fs';
import {createReadStream} from 'fs';
import {Readable} from 'stream';

export async function GET(req: Request) {
  if (!localModelsDir) return new Response('No local peer', {status: 400});
  const url = new URL(req.url);
  const file = url.searchParams.get('file');
  if (!file) return new Response('Missing file parameter', {status: 400});

  const base = nodePath.resolve(localModelsDir);
  const full = nodePath.resolve(base, file);
  if (!full.startsWith(base + nodePath.sep))
    return new Response('Invalid path', {status: 400});

  try {
    const {size} = await fsp.stat(full);
    const stream = createReadStream(full);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
      },
    });
  } catch {
    return new Response('File not found', {status: 404});
  }
}
