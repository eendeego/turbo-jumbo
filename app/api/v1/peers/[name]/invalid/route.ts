import {config, localPeer, localModelsDir, lemonadeDir} from '@/lib/config';
import {logger} from '@/lib/util/logger';
import {findReposWithInvalidFiles} from '@/lib/audit/incomplete-models';

// Repo ids with at least one invalid local file on the given peer. The local
// peer is computed directly; a remote peer is proxied to its own endpoint (peers
// run the same code), mirroring the models and incomplete routes.
export async function GET(
  _req: Request,
  {params}: {params: Promise<{name: string}>},
) {
  const {name} = await params;
  const peer = config.peers.find((p) => p.name === name);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    if (!localModelsDir) return Response.json({invalid: []});
    const invalid = await findReposWithInvalidFiles(
      localModelsDir,
      lemonadeDir,
    );
    return Response.json({invalid});
  }

  try {
    const res = await fetch(
      `http://${peer.address}/api/v1/local-models/invalid`,
    );
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return Response.json(await res.json());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] failed to fetch invalid from ${peer.name}: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
