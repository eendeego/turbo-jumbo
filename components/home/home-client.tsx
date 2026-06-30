'use client';

import {useMemo} from 'react';
import {AppShell} from '@astryxdesign/core/AppShell';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models';
import {AsyncState} from '@/lib/async-state';
import type {ModelRow} from '@/components/models/models-table-client';
import {ModelsTableClient} from '@/components/models/models-table-client';
import type {PeerModels} from '@/components/peers/peer';
import {usePeerModels} from '@/components/peers/use-peer-models';
import {Peers} from '@/components/peers/peers';
import {ColdStorage} from '@/components/models/cold-storage';
import {HuggingFaceDownload} from '@/components/hf-download/hugging-face-download';
import {Log} from '@/components/log/log';
import {ThemeToggle} from '@/components/theme/theme-toggle';

export function HomeClient({
  coldModels,
  localModelsPath,
  logLevel,
  modelsTableData,
  peerConfigs,
  localPeerAddress,
  localPeerModels,
}: {
  coldModels: Model[];
  localModelsPath: string | null;
  logLevel: string;
  modelsTableData: ModelRow[];
  peerConfigs: PeerConfig[];
  localPeerAddress: string | null;
  localPeerModels: Model[];
}) {
  const {peers, peerModels, handleModelsRefreshed} = usePeerModels();

  // Seed the local peer's models from server data so its location tokens are
  // active immediately, without waiting for the first client fetch.
  const seededPeerModels = useMemo(() => {
    if (!localPeerAddress) return peerModels;
    const lo = peerModels.get(localPeerAddress);
    if (lo && lo.type === 'value') return peerModels;
    const seeded = new Map<string, PeerModels>(peerModels);
    seeded.set(localPeerAddress, AsyncState.value(localPeerModels));
    return seeded;
  }, [peerModels, localPeerAddress, localPeerModels]);

  return (
    <AppShell contentPadding={6} height="auto">
      <VStack gap={6}>
        <HStack vAlign="center">
          <StackItem size="fill">
            <Heading level={1}>Turbo Jumbo</Heading>
          </StackItem>
          <ThemeToggle />
        </HStack>

        <ModelsTableClient
          models={modelsTableData}
          peers={peerConfigs}
          peerModels={seededPeerModels}
        />

        <Peers
          peers={peers}
          peerModels={seededPeerModels}
          coldModels={coldModels}
          onModelsRefreshed={handleModelsRefreshed}
        />

        {localModelsPath && (
          <HuggingFaceDownload localModelsPath={localModelsPath} />
        )}

        <Section>
          <VStack gap={3}>
            <Heading level={2}>Models in cold storage</Heading>
            <ColdStorage initialModels={coldModels} />
          </VStack>
        </Section>

        <Log logLevel={logLevel} />
      </VStack>
    </AppShell>
  );
}
