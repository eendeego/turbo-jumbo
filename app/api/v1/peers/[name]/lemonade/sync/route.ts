import {NextResponse} from 'next/server';
import {config, localPeer} from '@/lib/config';
import {logger} from '@/lib/util/logger';
import {previewSync, runSync} from '@/lib/lemonade/lemonade-sync-run';

// Consolidate Lemonade into Turbo Jumbo on a specific peer. The local peer runs
// it directly against its own config; a remote peer runs it on itself — we
// forward to its own /api/v1/lemonade/sync so the work uses that machine's
// stores. GET previews (read-only); POST executes.

export async function GET(
  _req: Request,
  {params}: {params: Promise<{name: string}>},
) {
  const {name} = await params;
  const peer = config.peers.find((p) => p.name === name);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    logger.debug(`[peers] lemonade sync preview on ${peer.name} (local)`);
    return NextResponse.json(await previewSync());
  }

  logger.debug(
    `[peers] lemonade sync preview on ${peer.name} (${peer.address})`,
  );
  try {
    const res = await fetch(`http://${peer.address}/api/v1/lemonade/sync`);
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return NextResponse.json(await res.json());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] lemonade sync preview on ${peer.name} failed: ${msg}`);
    return new Response(msg, {status: 502});
  }
}

export async function POST(
  _req: Request,
  {params}: {params: Promise<{name: string}>},
) {
  const {name} = await params;
  const peer = config.peers.find((p) => p.name === name);
  if (!peer) return new Response('Unknown peer', {status: 404});

  if (peer === localPeer) {
    logger.debug(`[peers] lemonade sync on ${peer.name} (local)`);
    const out = await runSync();
    if (!out) return new Response('Lemonade is not configured', {status: 400});
    return NextResponse.json(out);
  }

  logger.debug(`[peers] lemonade sync on ${peer.name} (${peer.address})`);
  try {
    const res = await fetch(`http://${peer.address}/api/v1/lemonade/sync`, {
      method: 'POST',
    });
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return NextResponse.json(await res.json());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] lemonade sync on ${peer.name} failed: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
