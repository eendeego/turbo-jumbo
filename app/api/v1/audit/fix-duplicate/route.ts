import path from 'path';
import {duplicateBasenames, scanModels} from '@/lib/models';
import {fixDuplicateGroup, type DuplicateFixResult} from '@/lib/fix-duplicates';
import {proxyAuditRequest, resolveAuditLocation} from '@/lib/audit-location';
import {hasOptionalStringFiles, readJsonBody} from '@/lib/request';
import {clearHfCache} from '@/lib/hf-infer';

/**
 * Resolve duplicate groups down to one verified copy each (see
 * `fixDuplicateGroup`). Group membership, validity, the survivor and its
 * target are all recomputed server-side from the request's file paths — the
 * same trust posture as the misplaced-Fix route — and results cover every
 * copy in a group, requested or not, so the client can clean up state for
 * unselected twins.
 */
export async function POST(req: Request) {
  const body = await readJsonBody<{
    location?: string;
    files?: string[];
  }>(req, hasOptionalStringFiles);
  if (body instanceof Response) return body;
  const {files} = body;

  const target = resolveAuditLocation(body.location);
  if (!target) {
    return new Response('Unsupported audit location', {status: 400});
  }
  if (target.kind === 'peer') {
    return proxyAuditRequest(
      target.peer,
      '/api/v1/audit/fix-duplicate',
      body,
      req.signal,
    );
  }
  const root = target.basePath;

  const selected = new Set(files ?? []);
  clearHfCache();

  const models = scanModels(root);
  const dups = duplicateBasenames(models);
  const results: DuplicateFixResult[] = [];
  const processed = new Set<string>();

  // A request may name several copies of one group; the group runs once.
  const fixGroup = async (
    relPath: string,
    modelName: string,
    filename: string,
  ) => {
    const groupPaths = dups.get(filename);
    if (!groupPaths) {
      results.push({
        file: relPath,
        status: 'skipped',
        message: 'not a duplicate',
      });
      return;
    }
    if (processed.has(filename)) return;
    processed.add(filename);
    results.push(
      ...(await fixDuplicateGroup(root, groupPaths, modelName, filename)),
    );
  };

  for (const model of models) {
    for (const file of model.files) {
      if (file.isSplit) {
        for (const shard of file.files) {
          if (!selected.has(shard.path)) continue;
          await fixGroup(shard.path, model.name, path.basename(shard.path));
        }
      } else {
        if (!selected.has(file.path)) continue;
        await fixGroup(file.path, model.name, file.filename);
      }
    }
  }

  return Response.json({results});
}
