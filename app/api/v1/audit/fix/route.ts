import path from 'path';
import {scanModels} from '@/lib/models/models';
import {
  expectedRelPath,
  moveFileWithMeta,
  refreshMetaSource,
  resolveSource,
  type FixResult,
} from '@/lib/audit/audit';
import {
  proxyAuditRequest,
  resolveAuditLocation,
} from '@/lib/audit/audit-location';
import {hasOptionalStringFiles, readJsonBody} from '@/lib/util/request';
import {clearHfCache} from '@/lib/hf/hf-infer';

/**
 * Relocate misplaced model files into their HuggingFace layout
 * (`<repoId>/<repoPath>`). The target is recomputed server-side from inference
 * rather than trusting a client-supplied path, so a request can only move the
 * selected files to where the audit would say they belong.
 */
export async function POST(req: Request) {
  const body = await readJsonBody<{
    location?: string;
    files?: string[];
  }>(req, hasOptionalStringFiles);
  if (body instanceof Response) return body;
  const {files} = body;

  const auditTarget = resolveAuditLocation(body.location);
  if (!auditTarget) {
    return new Response('Unsupported audit location', {status: 400});
  }
  if (auditTarget.kind === 'peer') {
    return proxyAuditRequest(
      auditTarget.peer,
      '/api/v1/audit/fix',
      body,
      req.signal,
    );
  }
  const root = auditTarget.basePath;

  const selected = new Set(files ?? []);
  clearHfCache();

  const results: FixResult[] = [];

  const fixOne = async (
    relPath: string,
    modelName: string,
    filename: string,
  ) => {
    // Same resolution the audit used (placement, inference, then a manually-set
    // sidecar source), so the relocation target matches the verdict that
    // surfaced Fix.
    const hf = await resolveSource(
      path.join(root, relPath),
      relPath,
      modelName,
      filename,
    );
    if (!hf) {
      results.push({file: relPath, status: 'skipped', message: 'unverifiable'});
      return;
    }
    const target = expectedRelPath(hf);
    if (target === relPath) {
      results.push({
        file: relPath,
        status: 'skipped',
        message: 'already placed',
      });
      return;
    }
    try {
      await moveFileWithMeta(root, relPath, target);
      // Refresh the relocated sidecar from the resolved source so the file ends
      // up with complete metadata (size + sha256) even if its sidecar predated
      // those fields or named a stale source.
      await refreshMetaSource(root, target, hf);
      results.push({file: relPath, status: 'moved', to: target});
    } catch (e) {
      results.push({
        file: relPath,
        status: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  for (const model of scanModels(root)) {
    for (const file of model.files) {
      if (file.isSplit) {
        for (const shard of file.files) {
          if (!selected.has(shard.path)) continue;
          await fixOne(shard.path, model.name, path.basename(shard.path));
        }
      } else {
        if (!selected.has(file.path)) continue;
        await fixOne(file.path, model.name, file.filename);
      }
    }
  }

  return Response.json({results});
}
