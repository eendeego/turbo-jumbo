import {config, localPeer} from '@/lib/config';
import {logger} from '@/lib/logger';
import {isObject, readJsonBody} from '@/lib/request';
import {streamHfDownload} from '@/lib/hf-download-stream';

// Run an HF download on a specific peer. The local peer runs it directly via
// the shared streamer; a remote peer runs it on itself — we forward the request
// to its own /api/v1/hf-download and pipe the streamed output straight back.
export async function POST(
  req: Request,
  {params}: {params: Promise<{name: string}>},
) {
  const {name} = await params;
  const peer = config.peers.find((p) => p.name === name);
  if (!peer) return new Response('Unknown peer', {status: 404});

  const body = await readJsonBody<Record<string, unknown>>(req, isObject);
  if (body instanceof Response) return body;

  if (peer === localPeer) {
    logger.debug(`[peers] hf-download on ${peer.name} (local)`);
    return streamHfDownload(body, req.signal);
  }

  logger.debug(`[peers] hf-download on ${peer.name} (${peer.address})`);
  try {
    const res = await fetch(`http://${peer.address}/api/v1/hf-download`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return new Response(res.body, {
      headers: {'Content-Type': 'text/plain; charset=utf-8'},
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] hf-download to ${peer.name} failed: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
