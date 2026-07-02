import {NextResponse} from 'next/server';
import nodePath from 'path';
import {localModelsDir, coldStorageDir, lemonadeDir} from '@/lib/config';
import {deleteFileWithMeta} from '@/lib/delete-file';
import {logger} from '@/lib/logger';
import {scanModels, annotateColdStorage} from '@/lib/models';
import {hasStringFiles, readJsonBody} from '@/lib/request';

export function GET(req: Request) {
  logger.trace('[models] list requested');
  let models = scanModels(localModelsDir, lemonadeDir);
  const url = new URL(req.url);
  if (url.searchParams.get('checkColdStorage') === 'true' && coldStorageDir)
    models = annotateColdStorage(models, coldStorageDir);
  logger.trace(`[models] list received: ${models.length} model(s)`);
  return NextResponse.json(models);
}

export async function DELETE(req: Request) {
  if (!localModelsDir) return new Response('No local peer', {status: 400});
  const body = await readJsonBody<{files: string[]; dryRun?: boolean}>(
    req,
    hasStringFiles,
  );
  if (body instanceof Response) return body;
  const {files} = body;
  const base = nodePath.resolve(localModelsDir);
  for (const file of files) {
    const full = nodePath.resolve(base, file);
    if (!full.startsWith(base + nodePath.sep))
      return new Response('Invalid path', {status: 400});
    if (body.dryRun) {
      logger.info(`[dry-run] would delete local: ${full}`);
    } else {
      await deleteFileWithMeta(base, nodePath.relative(base, full));
    }
  }
  return Response.json({ok: true, dryRun: body.dryRun ?? false});
}
