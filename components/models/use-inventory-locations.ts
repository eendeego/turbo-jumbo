'use client';

import {useMemo} from 'react';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models/models';
import type {InventoryLocation} from '@/lib/lemonade/lemonade';
import type {PeerModels} from '@/lib/peers/peer-models';
import {usePeerModels} from '@/components/peers/use-peer-models';
import {AsyncState} from '@/lib/util/async-state';

// Wraps usePeerModels and derives the inventory the Lemonade browser checks
// catalog entries against: every configured peer (local seeded from server
// data so its tokens are live immediately) plus cold storage. Shared by the
// table view and the Lemonade route so both build inventory identically.
export function useInventoryLocations({
  peerConfigs,
  localPeerAddress,
  localPeerModels,
  coldModels,
}: {
  peerConfigs: PeerConfig[];
  localPeerAddress: string | null;
  localPeerModels: Model[];
  coldModels: Model[];
}) {
  const {peers, peerModels, handleModelsRefreshed} = usePeerModels();

  const seededPeerModels = useMemo(() => {
    if (!localPeerAddress) return peerModels;
    const lo = peerModels.get(localPeerAddress);
    if (lo && lo.type === 'value') return peerModels;
    const seeded = new Map<string, PeerModels>(peerModels);
    seeded.set(localPeerAddress, AsyncState.value(localPeerModels));
    return seeded;
  }, [peerModels, localPeerAddress, localPeerModels]);

  const inventoryLocations = useMemo<InventoryLocation[]>(() => {
    const locs: InventoryLocation[] = peerConfigs.map((p) => {
      const lo = seededPeerModels.get(p.address);
      return {
        name: p.name,
        models: lo?.type === 'value' ? lo.value : [],
        isLocal: p.isLocal ?? false,
      };
    });
    locs.push({name: 'cold storage', models: coldModels});
    return locs;
  }, [peerConfigs, seededPeerModels, coldModels]);

  return {
    peers,
    peerModels,
    handleModelsRefreshed,
    seededPeerModels,
    inventoryLocations,
  };
}
