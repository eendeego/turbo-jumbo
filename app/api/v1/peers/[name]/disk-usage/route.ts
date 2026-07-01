import {config, localPeer, localModelsDir} from '@/lib/config';
import {logger} from '@/lib/logger';
import {diskUsage} from '@/lib/disk-usage';

// Free/total bytes of a specific peer's models filesystem. The local peer reads
// its own statfs; a remote peer is asked over its own /api/v1/disk-usage, so a
// download targeting that peer can be checked against the right disk.
export async function GET(
  _req: Request,
  {params}: {params: Promise<{name: string}>},
) {
  const {name} = await params;
  const peer = config.peers.find((p) => p.name === name);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    if (!localModelsDir) {
      return new Response('No local peer configured', {status: 400});
    }
    try {
      return Response.json(await diskUsage(localModelsDir));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[disk-usage] statfs on ${peer.name} failed: ${msg}`);
      return new Response(msg, {status: 500});
    }
  }

  try {
    const res = await fetch(`http://${peer.address}/api/v1/disk-usage`);
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return Response.json(await res.json());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[disk-usage] fetch from ${peer.name} failed: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
