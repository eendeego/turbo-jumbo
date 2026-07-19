import {config, localPeer} from '@/lib/config';
import {logger} from '@/lib/util/logger';
import {appVersion} from '@/lib/version/app-version';

// A specific peer's version identity. The local peer answers directly; a
// remote peer is asked over its own /api/v1/version — so the UI can compare
// what each machine runs and flag mismatched peers.
export async function GET(
  _req: Request,
  {params}: {params: Promise<{name: string}>},
) {
  const {name} = await params;
  const peer = config.peers.find((p) => p.name === name);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    return Response.json(appVersion());
  }

  try {
    const res = await fetch(`http://${peer.address}/api/v1/version`);
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return Response.json(await res.json());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[version] fetch from ${peer.name} failed: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
