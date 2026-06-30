'use client';

import {useState, useMemo, useCallback} from 'react';
import {useRouter} from 'next/navigation';
import {locationHref} from '@/lib/locations';
import {AppShell} from '@astryxdesign/core/AppShell';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {Divider} from '@astryxdesign/core/Divider';
import {Banner} from '@astryxdesign/core/Banner';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models';
import {AsyncState} from '@/lib/async-state';
import type {
  ModelRow,
  LocationTab,
} from '@/components/models/models-table-client';
import {ModelsTableClient} from '@/components/models/models-table-client';
import {ActionBar} from '@/components/models/action-bar';
import {
  DeleteModal,
  anyMissingFromColdStorage,
  type FileInfo,
} from '@/components/models/delete-modal';
import type {PeerModels} from '@/components/peers/peer';
import {usePeerModels} from '@/components/peers/use-peer-models';
import {Peers} from '@/components/peers/peers';
import {ColdStorage} from '@/components/models/cold-storage';
import {HuggingFaceDownload} from '@/components/hf-download/hugging-face-download';
import {Log} from '@/components/log/log';
import {ThemeToggle} from '@/components/theme/theme-toggle';

function selectedFileInfo(
  models: ModelRow[],
  selected: Set<string>,
): FileInfo[] {
  const result: FileInfo[] = [];
  for (const model of models) {
    for (const q of model.quants) {
      if (q.paths.length > 0 && q.paths.some((p) => selected.has(p))) {
        result.push({
          model: model.name,
          quant: q.label,
          filename: q.displayName,
        });
      }
    }
  }
  return result;
}

export function HomeClient({
  activeLocation,
  coldModels,
  localModelsPath,
  logLevel,
  modelsTableData,
  peerConfigs,
  localPeerAddress,
  localPeerModels,
}: {
  activeLocation: string;
  coldModels: Model[];
  localModelsPath: string | null;
  logLevel: string;
  modelsTableData: ModelRow[];
  peerConfigs: PeerConfig[];
  localPeerAddress: string | null;
  localPeerModels: Model[];
}) {
  const router = useRouter();
  const {peers, peerModels, handleModelsRefreshed} = usePeerModels();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locations: LocationTab[] = useMemo(
    () =>
      peerConfigs.map((p) => ({
        id: p.address,
        label: p.name,
        isLocal: p.isLocal ?? false,
      })),
    [peerConfigs],
  );

  const handleLocationChange = useCallback(
    (id: string) => {
      router.push(locationHref(id, peerConfigs));
    },
    [router, peerConfigs],
  );

  // Clear any selection whenever the active tab (URL) or the underlying model
  // data changes, using a render-phase reset rather than an effect.
  const [prevLocation, setPrevLocation] = useState(activeLocation);
  const [prevModels, setPrevModels] = useState(modelsTableData);
  if (prevLocation !== activeLocation || prevModels !== modelsTableData) {
    setPrevLocation(activeLocation);
    setPrevModels(modelsTableData);
    setSelected(new Set());
  }

  const onToggleSelected = useCallback((paths: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = paths.every((p) => next.has(p));
      if (allSelected) paths.forEach((p) => next.delete(p));
      else paths.forEach((p) => next.add(p));
      return next;
    });
  }, []);

  const deleteFromLabel = useMemo(() => {
    if (activeLocation === 'all') return 'all locations';
    if (activeLocation === 'cold-storage') return 'cold storage';
    const peer = peerConfigs.find((p) => p.address === activeLocation);
    if (!peer) return undefined;
    return peer.isLocal ? `${peer.name} (local)` : peer.name;
  }, [activeLocation, peerConfigs]);

  async function onDelete() {
    setConfirming(false);
    setDeleting(true);
    setError(null);
    try {
      let url: string;
      if (activeLocation === 'cold-storage') {
        url = '/api/v1/cold-storage';
      } else if (activeLocation === 'all') {
        url = '/api/v1/local-models';
      } else {
        const peer = peerConfigs.find((p) => p.address === activeLocation);
        if (!peer) throw new Error('Unknown location');
        url = `/api/v1/peers/${encodeURIComponent(peer.name)}/models`;
      }
      const del = await fetch(url, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({files: Array.from(selected)}),
      });
      if (!del.ok) throw new Error(`${del.status} ${del.statusText}`);
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

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

  const fileInfo = useMemo(
    () => selectedFileInfo(modelsTableData, selected),
    [modelsTableData, selected],
  );

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
          selected={selected}
          onToggleSelected={onToggleSelected}
          locations={locations}
          activeLocation={activeLocation}
          onLocationChange={handleLocationChange}
        />
        {error && <Banner status="error" title={`Error: ${error}`} />}
        <ActionBar
          selected={selected}
          onDelete={() => setConfirming(true)}
          deleting={deleting}
          onCopy={() => {}}
          copying={false}
        />

        {confirming && (
          <DeleteModal
            files={fileInfo}
            from={deleteFromLabel}
            requireDoubleConfirm={
              activeLocation === 'all' ||
              activeLocation === 'cold-storage' ||
              anyMissingFromColdStorage(fileInfo, coldModels)
            }
            onConfirm={onDelete}
            onCancel={() => setConfirming(false)}
          />
        )}

        <Divider />

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
