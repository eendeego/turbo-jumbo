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

export type RouteView = 'table' | 'lemonade' | 'hf';

// URL segments (optional catch-all) -> resolved location + which view to
// render. Returns null for unknown/invalid paths (caller should 404).
// A trailing ['download','lemonade'] or ['download','hf'] selects that view;
// the segments before it (0 or 1) name the location, resolved like a normal
// location path. Cold Storage has neither view; the HF view additionally
// requires the All view or the local peer (downloads run locally).
export function parseRoute(
  segments: string[] | undefined,
  peers: Peer[],
): {location: string; view: RouteView} | null {
  const segs = segments ?? [];
  const last = segs[segs.length - 1];
  const prev = segs[segs.length - 2];

  if (segs.length >= 2 && prev === 'download' && last === 'lemonade') {
    const head = segs.slice(0, -2);
    if (head.length > 1) return null;
    const location = resolveLocation(head, peers);
    if (location === null || location === COLD_STORAGE_LOCATION) return null;
    return {location, view: 'lemonade'};
  }

  if (segs.length >= 2 && prev === 'download' && last === 'hf') {
    const head = segs.slice(0, -2);
    if (head.length > 1) return null;
    const location = resolveLocation(head, peers);
    if (location === null) return null;
    // HF download runs locally: only the All view and the local peer qualify.
    if (location === ALL_LOCATION) return {location, view: 'hf'};
    const peer = peers.find((p) => p.address === location);
    if (peer?.isLocal) return {location, view: 'hf'};
    return null;
  }

  const location = resolveLocation(segs, peers);
  return location === null ? null : {location, view: 'table'};
}

// Internal tab id -> Lemonade route. The "all" tab's Lemonade lives at the
// bare /download/lemonade; a peer's under its slug. Cold Storage has none.
export function lemonadeHref(id: string, peers: Peer[]): string {
  if (id === ALL_LOCATION) return '/download/lemonade';
  if (id === COLD_STORAGE_LOCATION) return `/${COLD_STORAGE_LOCATION}`;
  const peer = peers.find((p) => p.address === id);
  return peer
    ? `/${slugifyPeerName(peer.name)}/download/lemonade`
    : '/download/lemonade';
}

// Internal tab id -> Hugging Face download route. Only the All view and the
// local peer have one; Cold Storage falls back to its table.
export function hfHref(id: string, peers: Peer[]): string {
  if (id === ALL_LOCATION) return '/download/hf';
  if (id === COLD_STORAGE_LOCATION) return `/${COLD_STORAGE_LOCATION}`;
  const peer = peers.find((p) => p.address === id);
  return peer ? `/${slugifyPeerName(peer.name)}/download/hf` : '/download/hf';
}
