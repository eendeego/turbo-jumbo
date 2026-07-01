import path from 'path';
import {duplicateBasenames, scanModels} from '@/lib/models';
import {
  cachedResultFromMeta,
  duplicateResult,
  readMetaResolved,
  type AuditResult,
} from '@/lib/audit';
import {proxyAuditRequest, resolveAuditLocation} from '@/lib/audit-location';

/**
 * Return the last-known audit verdicts for a location, derived purely from the
 * `.tjmeta.json` sidecars — no hashing, no network. The UI uses these to
 * pre-fill the Audit column (toned down) before a fresh run.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {location?: string};

  const target = resolveAuditLocation(body.location);
  if (!target) {
    return new Response('Unsupported audit location', {status: 400});
  }
  if (target.kind === 'peer') {
    return proxyAuditRequest(
      target.peer,
      '/api/v1/audit/cached',
      body,
      req.signal,
    );
  }
  const root = target.basePath;

  const results: AuditResult[] = [];
  const models = scanModels(root);
  const dups = duplicateBasenames(models);

  // Collisions short-circuit the sidecar read: the duplicate verdict is
  // scan-derived, so it's emitted even when no sidecar exists.
  const fromSidecar = async (relPath: string) => {
    const dupPaths = dups.get(path.basename(relPath));
    if (dupPaths) {
      results.push(duplicateResult(relPath, dupPaths, true));
      return;
    }
    const meta = await readMetaResolved(root, relPath);
    if (meta) results.push(cachedResultFromMeta(relPath, meta));
  };

  for (const model of models) {
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
