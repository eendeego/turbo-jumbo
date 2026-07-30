import {config} from '@/lib/config';
import {lemonadeApiBase} from '@/lib/lemonade/flm';
import {logger} from '@/lib/util/logger';
import {isObject, readJsonBody} from '@/lib/util/request';

// Ask the named peer's Lemonade server to download one of its models (an FLM
// model — the flm binary fetches the weights into that server's own store),
// relaying the server's SSE progress stream back to the browser. The events
// are tiny text frames, so piping them through this host is safe — unlike
// model bytes, which must never transit here. Closing the response aborts the
// upstream request, which Lemonade treats as a download cancel.
export async function POST(req: Request) {
  const body = await readJsonBody<{peer: string; model: string}>(req, isObject);
  if (body instanceof Response) return body;
  if (typeof body.peer !== 'string' || typeof body.model !== 'string')
    return new Response('Invalid body', {status: 400});
  const peer = config.peers.find((p) => p.name === body.peer);
  if (!peer) return new Response('Unknown peer', {status: 404});
  if (!peer.lemonade_url)
    return new Response('Peer has no Lemonade server configured', {
      status: 400,
    });
  const base = lemonadeApiBase(peer.lemonade_url);

  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort(), {once: true});

  logger.info(`[flm] pull ${body.model} on ${body.peer} (${base})`);
  let res: Response;
  try {
    res = await fetch(`${base}/pull`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model: body.model, stream: true}),
      signal: abort.signal,
    });
  } catch (e) {
    return new Response(
      `Lemonade server unreachable: ${e instanceof Error ? e.message : String(e)}`,
      {status: 502},
    );
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    return new Response(text || `Lemonade server: HTTP ${res.status}`, {
      status: 502,
    });
  }
  return new Response(res.body, {
    headers: {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'},
  });
}
