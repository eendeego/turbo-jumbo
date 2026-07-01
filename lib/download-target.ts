import {ALL_LOCATION} from '@/lib/locations';
import type {Peer} from '@/lib/config';

export interface DownloadTarget {
  url: string;
  displayPath: string;
}

function joinPath(base: string, sub: string): string {
  return `${base.replace(/\/+$/, '')}/${sub}`;
}

// The turbo-jumbo models directory on a peer, derived from its config the same
// way the server's resolveBaseSubdirs does. null when base_path is unset.
export function peerModelsDir(peer: Peer): string | null {
  if (!peer.base_path) return null;
  return joinPath(peer.base_path, peer.turbo_jumbo_subdir ?? 'turbo-jumbo');
}

// Where a download initiated from `activeLocation` runs. The All tab and the
// local peer download on this machine; a remote peer downloads on itself via
// the peer proxy. `displayPath` feeds only the cosmetic `hf` command preview.
export function downloadTarget(
  activeLocation: string,
  peers: Peer[],
  localModelsPath: string,
): DownloadTarget {
  const peer = peers.find((p) => p.address === activeLocation);
  if (activeLocation === ALL_LOCATION || !peer || peer.isLocal) {
    return {url: '/api/v1/hf-download', displayPath: localModelsPath};
  }
  return {
    url: `/api/v1/peers/${encodeURIComponent(peer.name)}/hf-download`,
    displayPath: peerModelsDir(peer) ?? `${peer.name} models directory`,
  };
}
