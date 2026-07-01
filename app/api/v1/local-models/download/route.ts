import {localModelsDir} from '@/lib/config';
import nodePath from 'path';
import {promises as fsp} from 'fs';

// Only HEAD remains: copy/check uses it to read a file's size/existence on a
// peer. The full-file GET download was the unbackpressured pull path the copy
// route used before peer transfers were forwarded to the peer itself; nothing
// calls it now, so it's gone rather than left as a way to OOM a serving host.
export async function HEAD(req: Request) {
  if (!localModelsDir) return new Response(null, {status: 400});
  const url = new URL(req.url);
  const file = url.searchParams.get('file');
  if (!file) return new Response(null, {status: 400});

  const base = nodePath.resolve(localModelsDir);
  const full = nodePath.resolve(base, file);
  if (!full.startsWith(base + nodePath.sep))
    return new Response(null, {status: 400});

  try {
    const {size} = await fsp.stat(full);
    return new Response(null, {headers: {'Content-Length': String(size)}});
  } catch {
    return new Response(null, {status: 404});
  }
}
