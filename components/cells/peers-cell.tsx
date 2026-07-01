'use client';

import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import type {Peer as PeerConfig} from '@/lib/config';
import {fileBasename, fileJoinKey} from '@/lib/peer-paths';
import type {DisplayRow, PeerPresence} from '@/lib/model-row';

/** First letter of a peer name, for the compact badge/header initials. */
const peerInitial = (name: string) => (name[0] ?? '?').toUpperCase();

/**
 * A peer's presence for a row, as a compact single-letter badge: blue for the
 * local peer, cyan for a remote one, neutral when absent, warning when
 * undersized. Identity is the initial; the full name + status is on hover.
 */
function PeerBadge({peer, status}: {peer: PeerConfig; status: PeerPresence}) {
  const variant =
    status === 'absent'
      ? 'neutral'
      : status === 'undersized'
        ? 'warning'
        : peer.isLocal
          ? 'blue'
          : 'cyan';
  const label = status === 'absent' ? 'not present' : status;
  return (
    <HoverCard placement="above" content={`${peer.name} — ${label}`}>
      <Badge label={peerInitial(peer.name)} variant={variant} />
    </HoverCard>
  );
}

export function PeersCell({
  row,
  peers,
  peerKeys,
}: {
  row: DisplayRow;
  peers: PeerConfig[];
  peerKeys: Map<string, Set<string>>;
}) {
  if (peers.length === 0 || row.depth === 2) return null;
  return (
    <HStack gap={1} vAlign="center" wrap="nowrap" hAlign="center">
      {peers.map((peer) => {
        // Joined by file key, not model name: names are derived per host and can
        // disagree for the same file, but a generic weight name is qualified by
        // the model so different repos don't collide (see lib/peer-paths.ts).
        const keys = peerKeys.get(peer.address);
        const hasPeer =
          keys != null &&
          row.paths.some((p) =>
            keys.has(fileJoinKey(row.parentName, fileBasename(p))),
          );
        const status: PeerPresence = !hasPeer
          ? 'absent'
          : row.undersizedLocations.has(peer.address)
            ? 'undersized'
            : 'present';
        return <PeerBadge key={peer.address} peer={peer} status={status} />;
      })}
    </HStack>
  );
}

/**
 * The Peers column header: the label plus the peer initials as a legend
 * (local in blue), full names on hover — so the cells can stay letters.
 */
export function PeersHeader({peers}: {peers: PeerConfig[]}) {
  return (
    <HStack gap={2} vAlign="center">
      <Text>Peers</Text>
      <HStack gap={1} vAlign="center">
        {peers.map((p) => (
          <HoverCard key={p.address} placement="above" content={p.name}>
            <Badge
              label={peerInitial(p.name)}
              variant={p.isLocal ? 'blue' : 'neutral'}
            />
          </HoverCard>
        ))}
      </HStack>
    </HStack>
  );
}
