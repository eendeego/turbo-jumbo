import {localModelsDir} from '@/lib/config';
import nodePath from 'path';
import {promises as fsp} from 'fs';
import {execFile} from 'child_process';
import {promisify} from 'util';

const execFileP = promisify(execFile);

// Report a local model file's size and md5, so another peer can compare it
// against its own copy before a transfer overwrites anything.
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
    const {stdout} = await execFileP('md5sum', [full]);
    const md5 = stdout.split(/\s+/)[0];
    return Response.json({size, md5});
  } catch {
    return new Response('File not found', {status: 404});
  }
}
