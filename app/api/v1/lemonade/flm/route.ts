import {config} from '@/lib/config';
import {
  lemonadeApiBase,
  parseFlmModels,
  type FlmSource,
} from '@/lib/lemonade/flm';
import {FLM_REGISTRY_URL, parseFlmRegistry} from '@/lib/lemonade/flm-registry';
import {logger} from '@/lib/util/logger';

// The registry changes rarely; cache it like the HF repo trees. A failed
// fetch caches an empty map for the TTL rather than hammering GitHub — the
// models then simply carry no source and fall back to Lemonade-server pulls.
const REGISTRY_TTL_MS = 30 * 60 * 1000;
let registryCache: {map: Map<string, FlmSource>; fetchedAt: number} | null =
  null;

async function flmRegistry(): Promise<Map<string, FlmSource>> {
  if (registryCache && Date.now() - registryCache.fetchedAt < REGISTRY_TTL_MS)
    return registryCache.map;
  let map = new Map<string, FlmSource>();
  try {
    const res = await fetch(FLM_REGISTRY_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) map = parseFlmRegistry(await res.json());
    else logger.warn(`[flm] registry fetch: HTTP ${res.status}`);
  } catch (e) {
    logger.warn(`[flm] registry fetch failed: ${String(e)}`);
  }
  registryCache = {map, fetchedAt: Date.now()};
  return map;
}

// The FLM (NPU) models of the named peer's Lemonade server, live. FLM models
// exist only inside a running Lemonade instance (discovered from its flm
// binary), so peers without a configured `lemonade_url` report unconfigured
// rather than empty — the UI can then hide the section instead of implying
// the server has no FLM models. Each model additionally carries the HF
// source its tag resolves to in FastFlowLM's public registry, when known.
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
    const registry = await flmRegistry();
    const models = parseFlmModels(await res.json()).map((m) => {
      const source = registry.get(m.checkpoint);
      return source ? {...m, source} : m;
    });
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
