import {localModelsDir} from '@/lib/config';
import {recordedSha256} from '@/lib/storage/recorded-digest';
import nodePath from 'path';
import {promises as fsp} from 'fs';
import {execFile} from 'child_process';
import {promisify} from 'util';

const execFileP = promisify(execFile);

// Report a local model file's size and a digest, so another peer can compare
// it against its own copy before a transfer overwrites anything.
//
// `recorded=1` asks for the SHA256 the file's sidecar already recorded and
// never reads the file's bytes: `sha256` is null when no trustworthy record
// exists, and the caller falls back to asking both sides for an md5. Without
// it the file is hashed, which on a large model means reading every byte.
export async function GET(req: Request) {
  if (!localModelsDir) return new Response('No local peer', {status: 400});
  const url = new URL(req.url);
  const file = url.searchParams.get('file');
  if (!file) return new Response('Missing file parameter', {status: 400});
  const recordedOnly = url.searchParams.get('recorded') === '1';

  const base = nodePath.resolve(localModelsDir);
  const full = nodePath.resolve(base, file);
  if (!full.startsWith(base + nodePath.sep))
    return new Response('Invalid path', {status: 400});

  try {
    const {size} = await fsp.stat(full);
    if (recordedOnly) {
      return Response.json({size, sha256: await recordedSha256(base, file)});
    }
    const {stdout} = await execFileP('md5sum', [full]);
    const md5 = stdout.split(/\s+/)[0];
    return Response.json({size, md5});
  } catch {
    return new Response('File not found', {status: 404});
  }
}
