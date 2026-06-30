import {config, localPeer, localModelsDir} from '@/lib/config';
import {logger} from '@/lib/logger';
import {scanModels} from '@/lib/models';

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
