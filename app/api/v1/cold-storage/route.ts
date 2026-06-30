import {NextResponse} from 'next/server';
import {promises as fsp} from 'fs';
import nodePath from 'path';
import {coldStorageDir} from '@/lib/config';
import {logger} from '@/lib/logger';
import {scanModels} from '@/lib/models';

export function GET() {
  const models = scanModels(coldStorageDir);
  return NextResponse.json(models);
}

export async function DELETE(req: Request) {
  if (!coldStorageDir) return new Response('No cold storage', {status: 400});
  const body = (await req.json()) as {files: string[]; dryRun?: boolean};
  const {files} = body;
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))
    return new Response('Invalid files', {status: 400});
  const base = nodePath.resolve(coldStorageDir);
  for (const file of files) {
    const full = nodePath.resolve(base, file);
    if (!full.startsWith(base + nodePath.sep))
      return new Response('Invalid path', {status: 400});
    if (body.dryRun) {
      logger.info(`[dry-run] would delete cold-storage: ${full}`);
    } else {
      await fsp.rm(full, {force: true});
    }
  }
  return Response.json({ok: true, dryRun: body.dryRun ?? false});
}
