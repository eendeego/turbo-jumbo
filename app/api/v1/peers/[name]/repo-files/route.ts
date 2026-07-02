import {config, localPeer, localModelsDir} from '@/lib/config';
import {logger} from '@/lib/util/logger';
import {repoFileStatuses} from '@/lib/models/repo-files';

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Per-file status for one repo on a given peer: computed locally for the local
// peer, proxied to the peer's own endpoint otherwise (mirrors the models route).
export async function GET(
  req: Request,
  {params}: {params: Promise<{name: string}>},
) {
  const {name} = await params;
  const peer = config.peers.find((p) => p.name === name);
  if (!peer) return new Response('Unknown peer', {status: 404});
  const repoId = new URL(req.url).searchParams.get('repoId') ?? '';
  if (!REPO_ID_RE.test(repoId))
    return new Response('Invalid repoId', {status: 400});

  if (peer === localPeer) {
    if (!localModelsDir) return new Response('No local peer', {status: 400});
    try {
      const files = await repoFileStatuses(localModelsDir, repoId);
      return Response.json({files});
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), {
        status: 502,
      });
    }
  }

  try {
    const res = await fetch(
      `http://${peer.address}/api/v1/local-models/repo-files?repoId=${encodeURIComponent(repoId)}`,
    );
    if (!res.ok)
      return new Response(`Peer returned ${res.status}`, {status: 502});
    return Response.json(await res.json());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[peers] failed to fetch repo-files from ${peer.name}: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
