import {config} from '@/lib/config';
import {lemonadeApiBase, parseFlmModels} from '@/lib/lemonade/flm';
import {logger} from '@/lib/util/logger';

// The FLM (NPU) models of the named peer's Lemonade server, live. FLM models
// exist only inside a running Lemonade instance (discovered from its flm
// binary), so peers without a configured `lemonade_url` report unconfigured
// rather than empty — the UI can then hide the section instead of implying
// the server has no FLM models.
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get('peer') ?? '';
  const peer = config.peers.find((p) => p.name === name);
  if (!peer) return new Response('Unknown peer', {status: 404});
  if (!peer.lemonade_url) return Response.json({configured: false, models: []});
  const base = lemonadeApiBase(peer.lemonade_url);
  try {
    const res = await fetch(`${base}/models?show_all=true`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok)
      return new Response(`Lemonade server: HTTP ${res.status}`, {status: 502});
    const models = parseFlmModels(await res.json());
    logger.trace(`[flm] ${name}: ${models.length} FLM model(s)`);
    return Response.json({configured: true, server: base, models});
  } catch (e) {
    logger.warn(`[flm] ${name} (${base}) unreachable: ${String(e)}`);
    return new Response(
      `Lemonade server unreachable: ${e instanceof Error ? e.message : String(e)}`,
      {status: 502},
    );
  }
}
