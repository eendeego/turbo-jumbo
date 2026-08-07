import {config, localPeer, localModelsDir, coldStorageDir} from '@/lib/config';
import {peerSlug} from '@/lib/peers/peer-slug';
import {logger} from '@/lib/util/logger';
import {downloadDiskUsage} from '@/lib/storage/disk-usage';

// Free/total bytes of a specific peer's models filesystem. The local peer reads
// its own statfs; a remote peer is asked over its own /api/v1/disk-usage, so a
// download targeting that peer can be checked against the right disk.
export async function GET(
  _req: Request,
  {params}: {params: Promise<{slug: string}>},
) {
  const {slug} = await params;
  const peer = config.peers.find((p) => peerSlug(p) === slug);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    if (!localModelsDir || !coldStorageDir) {
      return new Response('No local peer configured', {status: 400});
    }
    try {
      return Response.json(
        await downloadDiskUsage(localModelsDir, coldStorageDir),
      );
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
