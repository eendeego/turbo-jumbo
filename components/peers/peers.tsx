'use client';

import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/model-types';
import {Banner} from '@astryxdesign/core/Banner';
import {Peer, type PeerModels} from '@/components/peers/peer';
import type {AsyncState} from '@/lib/async-state';

// Renders one section per peer. Peer state is lifted to the parent (via
// usePeerModels) and passed in, so the models table and this section share it.
export function Peers({
  peers,
  peerModels,
  coldModels,
  onModelsRefreshed,
}: {
  peers: AsyncState<PeerConfig[]>;
  peerModels: Map<string, PeerModels>;
  coldModels: Model[];
  onModelsRefreshed: (address: string, models: Model[]) => void;
}) {
  if (peers.type === 'error')
    return (
      <Banner status="error" title={`Failed to load peers: ${peers.message}`} />
    );

  if (peers.type !== 'value' || peers.value.length === 0) return null;

  return (
    <>
      {peers.value.map((peer) => (
        <Peer
          key={peer.address}
          peer={peer}
          models={peerModels.get(peer.address) ?? {type: 'empty'}}
          coldModels={coldModels}
          onModelsRefreshed={onModelsRefreshed}
        />
      ))}
    </>
  );
}
