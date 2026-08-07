import type {Peer} from '@/lib/config';
import {peerSlug} from '@/lib/peers/peer-slug';

// Internal tab ids used throughout the app. Peer tabs use the peer's address as
// their id; these two are reserved sentinel ids.
export const ALL_LOCATION = 'all';
export const COLD_STORAGE_LOCATION = 'cold-storage';

// Internal tab id -> URL path. The "all" tab is canonically the root.
export function locationHref(id: string, peers: Peer[]): string {
  if (id === ALL_LOCATION) return '/';
  if (id === COLD_STORAGE_LOCATION) return `/${COLD_STORAGE_LOCATION}`;
  const peer = peers.find((p) => p.address === id);
  return peer ? `/${peerSlug(peer)}` : '/';
}

// URL segments (from an optional catch-all) -> internal tab id, or null when
// the path doesn't correspond to a known tab. Reserved slugs win over a peer
// claiming the same one — config validation rejects that, but the order here
// keeps the reserved tabs reachable regardless.
export function resolveLocation(
  segments: string[] | undefined,
  peers: Peer[],
): string | null {
  if (!segments || segments.length === 0) return ALL_LOCATION;
  if (segments.length > 1) return null;
  const slug = segments[0];
  if (slug === ALL_LOCATION) return ALL_LOCATION;
  if (slug === COLD_STORAGE_LOCATION) return COLD_STORAGE_LOCATION;
  const peer = peers.find((p) => peerSlug(p) === slug);
  return peer ? peer.address : null;
}

export type RouteView = 'table' | 'lemonade' | 'hf';

// URL segments (optional catch-all) -> resolved location + which view to
// render. Returns null for unknown/invalid paths (caller should 404).
// A trailing ['download','lemonade'] or ['download','hf'] selects that view;
// the segments before it (0 or 1) name the location, resolved like a normal
// location path. Cold Storage has neither view; every other location (All and
// any peer) has both.
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
    if (location === null || location === COLD_STORAGE_LOCATION) return null;
    return {location, view: 'hf'};
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
  return peer ? `/${peerSlug(peer)}/download/lemonade` : '/download/lemonade';
}

// Internal tab id -> Hugging Face download route. The All view and every peer
// tab have one; Cold Storage falls back to its table.
export function hfHref(id: string, peers: Peer[]): string {
  if (id === ALL_LOCATION) return '/download/hf';
  if (id === COLD_STORAGE_LOCATION) return `/${COLD_STORAGE_LOCATION}`;
  const peer = peers.find((p) => p.address === id);
  return peer ? `/${peerSlug(peer)}/download/hf` : '/download/hf';
}
