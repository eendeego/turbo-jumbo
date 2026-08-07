import {
  config,
  localPeer,
  localModelsDir,
  coldStorageDir,
  lemonadeDir,
} from '@/lib/config';
import {peerSlug} from '@/lib/peers/peer-slug';
import {logger} from '@/lib/util/logger';
import {scanModels, annotateColdStorage} from '@/lib/models/models';
import {hasStringFiles, readJsonBody} from '@/lib/util/request';
import {deleteFileWithMeta} from '@/lib/storage/delete-file';
import nodePath from 'path';

// Proxy a peer's models through the local server: scan locally for the local
// peer, or forward to the named remote peer. Lets the browser fetch every
// peer's models same-origin instead of calling each peer cross-origin.
export async function GET(
  _req: Request,
  {params}: {params: Promise<{slug: string}>},
) {
  const {slug} = await params;

  const peer = config.peers.find((p) => peerSlug(p) === slug);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    logger.debug(`[peers] fetch models from ${peer.name} (local)`);
    let models = scanModels(localModelsDir, lemonadeDir);
    if (coldStorageDir) models = annotateColdStorage(models, coldStorageDir);
    logger.debug(`[peers] ${peer.name} returned ${models.length} model(s)`);
    return Response.json(models);
  }

  logger.debug(`[peers] fetch models from ${peer.name} (${peer.address})`);
  try {
    const res = await fetch(
      `http://${peer.address}/api/v1/local-models?checkColdStorage=true`,
    );
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    const models = await res.json();
    logger.debug(`[peers] ${peer.name} returned ${models.length} model(s)`);
    return Response.json(models);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] failed to fetch models from ${peer.name}: ${msg}`);
    return new Response(msg, {status: 502});
  }
}

export async function DELETE(
  req: Request,
  {params}: {params: Promise<{slug: string}>},
) {
  const {slug} = await params;

  const peer = config.peers.find((p) => peerSlug(p) === slug);
  if (!peer) return new Response('Unknown peer', {status: 404});

  const body = await readJsonBody<{files: string[]; dryRun?: boolean}>(
    req,
    hasStringFiles,
  );
  if (body instanceof Response) return body;
  const {files} = body;

  if (peer === localPeer) {
    if (!localModelsDir) return new Response('No local peer', {status: 400});
    logger.debug(
      `[peers] delete ${files.length} file(s) from ${peer.name} (local)`,
    );
    const base = nodePath.resolve(localModelsDir);
    for (const file of files) {
      const full = nodePath.resolve(base, file);
      if (!full.startsWith(base + nodePath.sep))
        return new Response('Invalid path', {status: 400});
      if (body.dryRun) {
        logger.info(`[dry-run] would delete peer ${peer.name}: ${full}`);
      } else {
        await deleteFileWithMeta(base, nodePath.relative(base, full));
      }
    }
    return Response.json({ok: true, dryRun: body.dryRun ?? false});
  }

  logger.debug(
    `[peers] delete ${files.length} file(s) from ${peer.name} (${peer.address})`,
  );
  try {
    const res = await fetch(`http://${peer.address}/api/v1/local-models`, {
      method: 'DELETE',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({files, dryRun: body.dryRun}),
    });
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return Response.json({ok: true, dryRun: body.dryRun ?? false});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] failed to delete models from ${peer.name}: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
