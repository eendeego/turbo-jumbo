import path from 'path';
import {localModelsDir, coldStorageDir} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {
  expectedRelPath,
  moveFileWithMeta,
  refreshMetaSource,
  resolveSource,
  type FixResult,
} from '@/lib/audit';
import {clearHfCache} from '@/lib/hf-infer';

/**
 * Relocate misplaced model files into their HuggingFace layout
 * (`<repoId>/<repoPath>`). The target is recomputed server-side from inference
 * rather than trusting a client-supplied path, so a request can only move the
 * selected files to where the audit would say they belong.
 */
export async function POST(req: Request) {
  const {location, files} = (await req.json()) as {
    location?: string;
    files?: string[];
  };

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

  const selected = new Set(files ?? []);
  clearHfCache();

  const results: FixResult[] = [];

  const fixOne = async (
    relPath: string,
    modelName: string,
    filename: string,
  ) => {
    // Same resolution the audit used (inference, then a manually-set sidecar
    // source), so the relocation target matches the verdict that surfaced Fix.
    const hf = await resolveSource(
      path.join(root, relPath),
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
      await refreshMetaSource(path.join(root, target), hf);
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
