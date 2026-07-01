import path from 'path';
import {existsSync} from 'fs';
import {duplicateBasenames, scanModels} from '@/lib/models';
import {
  cachedResultFromMeta,
  duplicateResult,
  readMetaResolved,
  type AuditResult,
} from '@/lib/audit';
import {
  entryToMeta,
  findModelSidecarDirs,
  readModelSidecar,
} from '@/lib/model-sidecar';
import {proxyAuditRequest, resolveAuditLocation} from '@/lib/audit-location';
import {isObject, readJsonBody} from '@/lib/request';

/**
 * Return the last-known audit verdicts for a location, derived purely from the
 * `.tjmeta.json` sidecars — no hashing, no network. The UI uses these to
 * pre-fill the Audit column (toned down) before a fresh run.
 */
export async function POST(req: Request) {
  const body = await readJsonBody<{location?: string}>(req, isObject);
  if (body instanceof Response) return body;

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

  // The live on-disk size of every scanned file (scanModels already stat'd
  // them). Passed to cachedResultFromMeta so a sidecar that out-lived a
  // truncation of its file — an interrupted copy leaves the old passing record
  // — can't report a stale `pass` against a now-incomplete file.
  const sizeByPath = new Map<string, number>();
  for (const model of models) {
    for (const file of model.files) {
      if (file.isSplit) {
        for (const shard of file.files) sizeByPath.set(shard.path, shard.size);
      } else {
        sizeByPath.set(file.path, file.size);
      }
    }
  }

  // Collisions short-circuit the sidecar read: the duplicate verdict is
  // scan-derived, so it's emitted even when no sidecar exists.
  const fromSidecar = async (relPath: string) => {
    const dupPaths = dups.get(path.basename(relPath));
    if (dupPaths) {
      results.push(duplicateResult(relPath, dupPaths, true));
      return;
    }
    const meta = await readMetaResolved(root, relPath);
    if (meta)
      results.push(
        cachedResultFromMeta(relPath, meta, sizeByPath.get(relPath)),
      );
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

  // Files a prior audit recorded as expected-on-HF but absent on disk live only
  // in the sidecar — `scanModels` can't see them. Surface each as incomplete,
  // skipping any that have since been downloaded (a stale flag).
  for (const dir of await findModelSidecarDirs(root)) {
    const sidecar = await readModelSidecar(root, dir);
    if (!sidecar) continue;
    for (const entry of sidecar.files) {
      if (!entry.missing) continue;
      const relPath = path.join(dir, entry.path);
      if (existsSync(path.join(root, relPath))) continue;
      results.push(
        cachedResultFromMeta(relPath, entryToMeta(sidecar.modelUrl, entry)),
      );
    }
  }

  return Response.json({results});
}
