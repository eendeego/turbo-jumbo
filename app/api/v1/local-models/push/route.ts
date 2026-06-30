import {localModelsDir} from '@/lib/config';
import nodePath from 'path';
import {createReadStream} from 'fs';
import {Readable} from 'stream';

type PushRequest = {
  files: string[];
  toPeer: string;
};

export async function POST(req: Request) {
  if (!localModelsDir) return new Response('No local peer', {status: 400});
  const body = (await req.json()) as PushRequest;
  const {files, toPeer} = body;

  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))
    return new Response('Invalid files', {status: 400});
  if (typeof toPeer !== 'string' || !toPeer)
    return new Response('Invalid toPeer', {status: 400});

  const base = nodePath.resolve(localModelsDir);

  for (const file of files) {
    const full = nodePath.resolve(base, file);
    if (!full.startsWith(base + nodePath.sep))
      return new Response('Invalid path', {status: 400});

    const readable = createReadStream(full);
    const res = await fetch(`http://${toPeer}/api/v1/local-models/upload`, {
      method: 'POST',
      headers: {
        'x-file-path': file,
        'Content-Type': 'application/octet-stream',
      },
      body: Readable.toWeb(readable) as unknown as BodyInit,
      // @ts-expect-error – duplex required for streaming request bodies in Node fetch
      duplex: 'half',
    });
    if (!res.ok)
      return new Response(`Upload to peer failed: ${await res.text()}`, {
        status: 502,
      });
  }

  return Response.json({ok: true});
}
