import path from 'path';
import {localModelsDir, coldStorageDir} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {cachedResultFromMeta, readMeta, type AuditResult} from '@/lib/audit';

/**
 * Return the last-known audit verdicts for a location, derived purely from the
 * `.tjmeta.json` sidecars — no hashing, no network. The UI uses these to
 * pre-fill the Audit column (toned down) before a fresh run.
 */
export async function POST(req: Request) {
  const {location} = (await req.json()) as {location?: string};

  let basePath: string | undefined;
  if (location === 'cold-storage') {
    basePath = coldStorageDir;
  } else if (location === 'local') {
    basePath = localModelsDir;
  } else {
    return new Response('Unsupported audit location', {status: 400});
  }
  if (!basePath) {
    return new Response('Location not configured', {status: 400});
  }
  const root = basePath;

  const results: AuditResult[] = [];

  const fromSidecar = async (relPath: string) => {
    const meta = await readMeta(path.join(root, relPath));
    if (meta) results.push(cachedResultFromMeta(relPath, meta));
  };

  for (const model of scanModels(root)) {
    for (const file of model.files) {
      if (file.isSplit) {
        for (const shard of file.files) await fromSidecar(shard.path);
      } else {
        await fromSidecar(file.path);
      }
    }
  }

  return Response.json({results});
}
