import {NextResponse} from 'next/server';
import nodePath from 'path';
import {coldStorageDir} from '@/lib/config';
import {deleteFileWithMeta} from '@/lib/delete-file';
import {logger} from '@/lib/logger';
import {scanModels} from '@/lib/models';
import {hasStringFiles, readJsonBody} from '@/lib/request';

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
  for (const file of files) {
    const full = nodePath.resolve(base, file);
    if (!full.startsWith(base + nodePath.sep))
      return new Response('Invalid path', {status: 400});
    if (body.dryRun) {
      logger.info(`[dry-run] would delete cold-storage: ${full}`);
    } else {
      await deleteFileWithMeta(base, nodePath.relative(base, full));
    }
  }
  return Response.json({ok: true, dryRun: body.dryRun ?? false});
}
