import {NextResponse} from 'next/server';
import nodePath from 'path';
import {coldStorageDir} from '@/lib/config';
import {
  cleanupWeightlessModelDirs,
  deleteFileWithMeta,
} from '@/lib/storage/delete-file';
import {logger} from '@/lib/util/logger';
import {scanModels} from '@/lib/models/models';
import {hasStringFiles, readJsonBody} from '@/lib/util/request';

export function GET() {
  const models = scanModels(coldStorageDir);
  return NextResponse.json(models);
}

export async function DELETE(req: Request) {
  if (!coldStorageDir) return new Response('No cold storage', {status: 400});
  const body = await readJsonBody<{files: string[]; dryRun?: boolean}>(
    req,
    hasStringFiles,
  );
  if (body instanceof Response) return body;
  const {files} = body;
  const base = nodePath.resolve(coldStorageDir);
  const deleted: string[] = [];
  for (const file of files) {
    const full = nodePath.resolve(base, file);
    if (!full.startsWith(base + nodePath.sep))
      return new Response('Invalid path', {status: 400});
    if (body.dryRun) {
      logger.info(`[dry-run] would delete cold-storage: ${full}`);
    } else {
      const rel = nodePath.relative(base, full);
      await deleteFileWithMeta(base, rel);
      deleted.push(rel);
    }
  }
  // A model dir stripped of its last weight takes its support files
  // (config/tokenizer/…) with it — they belong to the deleted weights.
  await cleanupWeightlessModelDirs(base, deleted);
  return Response.json({ok: true, dryRun: body.dryRun ?? false});
}
