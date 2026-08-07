import type {Peer} from '@/lib/config';

// A peer's URL-safe identity: the segment naming it in its tab path (/zurich)
// and in the peer proxy endpoints (/api/v1/peers/<slug>/…). Config may set it
// explicitly — necessary when the name is Unicode, since deriving a slug from
// it mangles or empties it. This module stays free of `fs` so client code can
// import it (lib/config cannot be imported in the browser).

// Path segments a peer tab would otherwise shadow: the two reserved location
// ids, the download views nested under a location, and the API root.
export const RESERVED_SLUGS = ['all', 'cold-storage', 'download', 'api'];

export function slugifyPeerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function peerSlug(peer: Peer): string {
  return peer.slug ?? slugifyPeerName(peer.name);
}

/**
 * The cross-peer slug rules, which JSON Schema can't express: every peer needs
 * a slug, no two may share one, and none may take a reserved segment. Returns
 * null when the peers are fine, or a message naming the offender and what to
 * do about it. Called during config validation so a bad config fails at boot
 * rather than 404ing a tab later.
 */
export function peerSlugError(peers: Peer[]): string | null {
  const seen = new Map<string, Peer>();
  for (const peer of peers) {
    const slug = peerSlug(peer);
    if (!slug) {
      return `peer "${peer.name}" has no usable slug (its name yields none); set "slug" explicitly`;
    }
    if (RESERVED_SLUGS.includes(slug)) {
      return `peer "${peer.name}" resolves to the reserved slug "${slug}"; set "slug" explicitly`;
    }
    const clash = seen.get(slug);
    if (clash) {
      return `peers "${clash.name}" and "${peer.name}" resolve to the same slug "${slug}"; set "slug" on one of them`;
    }
    seen.set(slug, peer);
  }
  return null;
}
