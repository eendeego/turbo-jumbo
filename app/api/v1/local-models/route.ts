import {NextResponse} from 'next/server';
import {promises as fsp} from 'fs';
import nodePath from 'path';
import {localModelsDir} from '@/lib/config';
import {logger} from '@/lib/logger';
import {scanModels} from '@/lib/models';

export function GET() {
  logger.trace('[models] list requested');
  const models = scanModels(localModelsDir);
  logger.trace(`[models] list received: ${models.length} model(s)`);
  return NextResponse.json(models);
}

export async function DELETE(req: Request) {
  if (!localModelsDir) return new Response('No local peer', {status: 400});
  const {files} = (await req.json()) as {files: string[]};
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))
    return new Response('Invalid files', {status: 400});
  const base = nodePath.resolve(localModelsDir);
  for (const file of files) {
    const full = nodePath.resolve(base, file);
    if (!full.startsWith(base + nodePath.sep))
      return new Response('Invalid path', {status: 400});
    await fsp.rm(full, {force: true});
  }
  return Response.json({ok: true});
}
