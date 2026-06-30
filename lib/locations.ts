import type {Peer} from '@/lib/config';

// Internal tab ids used throughout the app. Peer tabs use the peer's address as
// their id; these two are reserved sentinel ids.
export const ALL_LOCATION = 'all';
export const COLD_STORAGE_LOCATION = 'cold-storage';

export function slugifyPeerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Internal tab id -> URL path. The "all" tab is canonically the root.
export function locationHref(id: string, peers: Peer[]): string {
  if (id === ALL_LOCATION) return '/';
  if (id === COLD_STORAGE_LOCATION) return `/${COLD_STORAGE_LOCATION}`;
  const peer = peers.find((p) => p.address === id);
  return peer ? `/${slugifyPeerName(peer.name)}` : '/';
}

// URL segments (from an optional catch-all) -> internal tab id, or null when
// the path doesn't correspond to a known tab. Reserved slugs win over a peer
// that happens to slugify to the same value.
export function resolveLocation(
  segments: string[] | undefined,
  peers: Peer[],
): string | null {
  if (!segments || segments.length === 0) return ALL_LOCATION;
  if (segments.length > 1) return null;
  const slug = segments[0];
  if (slug === ALL_LOCATION) return ALL_LOCATION;
  if (slug === COLD_STORAGE_LOCATION) return COLD_STORAGE_LOCATION;
  const peer = peers.find((p) => slugifyPeerName(p.name) === slug);
  return peer ? peer.address : null;
}
