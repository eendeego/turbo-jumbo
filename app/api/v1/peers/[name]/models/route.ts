import {config, localPeer, localModelsDir} from '@/lib/config';
import {logger} from '@/lib/logger';
import {scanModels} from '@/lib/models';
import {promises as fsp} from 'fs';
import nodePath from 'path';

// Proxy a peer's models through the local server: scan locally for the local
// peer, or forward to the named remote peer. Lets the browser fetch every
// peer's models same-origin instead of calling each peer cross-origin.
export async function GET(
  _req: Request,
  {params}: {params: Promise<{name: string}>},
) {
  const {name} = await params;

  const peer = config.peers.find((p) => p.name === name);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    logger.debug(`[peers] fetch models from ${peer.name} (local)`);
    const models = scanModels(localModelsDir);
    logger.debug(`[peers] ${peer.name} returned ${models.length} model(s)`);
    return Response.json(models);
  }

  logger.debug(`[peers] fetch models from ${peer.name} (${peer.address})`);
  try {
    const res = await fetch(`http://${peer.address}/api/v1/local-models`);
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
  {params}: {params: Promise<{name: string}>},
) {
  const {name} = await params;

  const peer = config.peers.find((p) => p.name === name);
  if (!peer) return new Response('Unknown peer', {status: 404});

  const {files} = (await req.json()) as {files: string[]};
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))
    return new Response('Invalid files', {status: 400});

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
      await fsp.rm(full, {force: true});
    }
    return Response.json({ok: true});
  }

  logger.debug(
    `[peers] delete ${files.length} file(s) from ${peer.name} (${peer.address})`,
  );
  try {
    const res = await fetch(`http://${peer.address}/api/v1/local-models`, {
      method: 'DELETE',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({files}),
    });
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return Response.json({ok: true});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] failed to delete models from ${peer.name}: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
