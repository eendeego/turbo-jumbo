import {
  config,
  localPeer,
  localModelsDir,
  coldStorageDir,
  type Peer,
} from '@/lib/config';
import {logger} from '@/lib/util/logger';

export type AuditTarget =
  {kind: 'path'; basePath: string} | {kind: 'peer'; peer: Peer};

/**
 * Resolve an audit location to its target: 'local' and 'cold-storage' map to
 * this host's storage roots; a remote peer's address means the request should
 * be proxied to that peer (which audits its own local storage).
 */
export function resolveAuditLocation(
  location: string | undefined,
): AuditTarget | null {
  if (location === 'cold-storage') {
    return coldStorageDir ? {kind: 'path', basePath: coldStorageDir} : null;
  }
  if (location === 'local') {
    return localModelsDir ? {kind: 'path', basePath: localModelsDir} : null;
  }
  const peer = config.peers.find((p) => p.address === location);
  if (peer && peer !== localPeer) return {kind: 'peer', peer};
  return null;
}

/**
 * Forward an audit request to a peer as a 'local' audit of its own storage
 * and pass the response — streaming NDJSON included — straight through. The
 * caller's abort signal propagates so the peer stops hashing when the browser
 * disconnects.
 */
export async function proxyAuditRequest(
  peer: Peer,
  pathname: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  logger.debug(`[audit] proxy ${pathname} to ${peer.name} (${peer.address})`);
  try {
    const res = await fetch(`http://${peer.address}${pathname}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...body, location: 'local'}),
      signal,
    });
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[audit] proxy ${pathname} to ${peer.name} failed: ${msg}`);
    return new Response(msg, {status: 502});
  }
}
