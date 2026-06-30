'use client';

import {useState, useMemo, useCallback} from 'react';
import * as stylex from '@stylexjs/stylex';
import {useRouter} from 'next/navigation';
import {locationHref} from '@/lib/locations';
import {AppShell} from '@astryxdesign/core/AppShell';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {Divider} from '@astryxdesign/core/Divider';
import {Banner} from '@astryxdesign/core/Banner';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models';
import {AsyncState} from '@/lib/async-state';
import type {
  ModelRow,
  LocationTab,
} from '@/components/models/models-table-client';
import {
  ModelsTableClient,
  LocationTabs,
} from '@/components/models/models-table-client';
import {ActionBar} from '@/components/models/action-bar';
import {type CopyProgress, readCopyProgress} from '@/lib/copy-progress';
import {
  DeleteModal,
  anyMissingFromColdStorage,
  type FileInfo,
} from '@/components/models/delete-modal';
import {CopyModal, type CopyDestinations} from '@/components/models/copy-modal';
import {
  ConflictsModal,
  type ConflictItem,
} from '@/components/models/conflicts-modal';
import type {PeerModels} from '@/components/peers/peer';
import {usePeerModels} from '@/components/peers/use-peer-models';
import {Peers} from '@/components/peers/peers';
import {ColdStorage} from '@/components/models/cold-storage';
import {HuggingFaceDownload} from '@/components/hf-download/hugging-face-download';
import {Log} from '@/components/log/log';
import {ThemeToggle} from '@/components/theme/theme-toggle';

const styles = stylex.create({
  // The models table spans the full content width; the sections below it sit in
  // a narrower reading column.
  narrow: {maxWidth: '42rem', width: '100%'},
});

function selectedFileInfo(
  models: ModelRow[],
  selected: Set<string>,
): FileInfo[] {
  const result: FileInfo[] = [];
  for (const model of models) {
    for (const q of model.quants) {
      const allPaths = new Set([...q.paths, ...q.coldPaths]);
      const matchedPaths = [...allPaths].filter((p) => selected.has(p));
      if (matchedPaths.length === 0) continue;

      if (q.isSingleFile || matchedPaths.length === 1) {
        result.push({
          model: model.name,
          quant: q.label,
          filename: q.displayName,
        });
      } else {
        // Split quant with multiple selected shards: list each shard file.
        for (const p of matchedPaths) {
          result.push({
            model: model.name,
            quant: q.label,
            filename: p.split('/').pop() ?? p,
          });
        }
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
  const [confirmingCopy, setConfirmingCopy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [pendingConflicts, setPendingConflicts] = useState<ConflictItem[]>([]);
  const [pendingDestinations, setPendingDestinations] =
    useState<CopyDestinations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const isDev = process.env.NODE_ENV === 'development';

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
      const headers = {'Content-Type': 'application/json'};
      const body = JSON.stringify({
        files: Array.from(selected),
        ...(dryRun ? {dryRun: true} : {}),
      });

      if (activeLocation === 'all') {
        // Delete from every location in parallel.
        const requests: Promise<Response>[] = [
          fetch('/api/v1/local-models', {method: 'DELETE', headers, body}),
          fetch('/api/v1/cold-storage', {method: 'DELETE', headers, body}),
          ...peerConfigs
            .filter((p) => !p.isLocal)
            .map((p) =>
              fetch(`/api/v1/peers/${encodeURIComponent(p.name)}/models`, {
                method: 'DELETE',
                headers,
                body,
              }),
            ),
        ];
        const results = await Promise.allSettled(requests);
        const failed = results.filter((r) => r.status === 'rejected');
        if (failed.length > 0)
          throw new Error(`${failed.length} delete request(s) failed`);
      } else {
        let url: string;
        if (activeLocation === 'cold-storage') {
          url = '/api/v1/cold-storage';
        } else {
          const peer = peerConfigs.find((p) => p.address === activeLocation);
          if (!peer) throw new Error('Unknown location');
          url = `/api/v1/peers/${encodeURIComponent(peer.name)}/models`;
        }
        const del = await fetch(url, {method: 'DELETE', headers, body});
        if (!del.ok) throw new Error(`${del.status} ${del.statusText}`);
      }

      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  // The copy source for the active tab: the local peer on "All", otherwise the
  // tab's own location.
  const copyFromSource = useMemo(() => {
    if (activeLocation === 'cold-storage') return 'cold-storage';
    if (activeLocation === 'all') return localPeerAddress ?? '';
    return activeLocation;
  }, [activeLocation, localPeerAddress]);

  async function onCopy(destinations: CopyDestinations) {
    setConfirmingCopy(false);
    setChecking(true);
    setError(null);
    let hasConflicts = false;
    let hasError = false;
    try {
      const res = await fetch('/api/v1/copy/check', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: Array.from(selected),
          from: copyFromSource,
          toColdStorage: destinations.toColdStorage,
          toPeers: destinations.toPeers,
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const {conflicts} = (await res.json()) as {conflicts: ConflictItem[]};
      if (conflicts.length > 0) {
        hasConflicts = true;
        setPendingConflicts(conflicts);
        setPendingDestinations(destinations);
      }
    } catch (e) {
      hasError = true;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
    if (!hasConflicts && !hasError) await doCopy(destinations, []);
  }

  async function onConflictsConfirm(
    skip: Array<{file: string; destination: string}>,
  ) {
    if (!pendingDestinations) return;
    const dest = pendingDestinations;
    setPendingConflicts([]);
    setPendingDestinations(null);
    await doCopy(dest, skip);
  }

  async function doCopy(
    destinations: CopyDestinations,
    skip: Array<{file: string; destination: string}>,
  ) {
    setCopying(true);
    setCopyProgress(null);
    setError(null);
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: Array.from(selected),
          from: copyFromSource,
          ...destinations,
          skip,
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await readCopyProgress(res, setCopyProgress);
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCopying(false);
      setCopyProgress(null);
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

        <LocationTabs
          locations={locations}
          activeLocation={activeLocation}
          onLocationChange={handleLocationChange}
        />
        <ModelsTableClient
          models={modelsTableData}
          peers={peerConfigs}
          peerModels={seededPeerModels}
          selected={selected}
          onToggleSelected={onToggleSelected}
          locations={locations}
          activeLocation={activeLocation}
        />
        {error && <Banner status="error" title={`Error: ${error}`} />}
        <ActionBar
          selected={selected}
          onDelete={() => setConfirming(true)}
          deleting={deleting}
          onCopy={() => setConfirmingCopy(true)}
          copying={copying}
          copyProgress={copyProgress}
          checking={checking}
        />
        {isDev && selected.size > 0 && (
          <CheckboxInput
            label="Dry run (log only, no actual deletion)"
            value={dryRun}
            onChange={setDryRun}
            size="sm"
          />
        )}

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
        {confirmingCopy && (
          <CopyModal
            files={fileInfo}
            from={copyFromSource}
            onCopy={onCopy}
            onCancel={() => setConfirmingCopy(false)}
          />
        )}
        {pendingConflicts.length > 0 && (
          <ConflictsModal
            conflicts={pendingConflicts}
            peers={peerConfigs}
            onConfirm={onConflictsConfirm}
            onCancel={() => {
              setPendingConflicts([]);
              setPendingDestinations(null);
            }}
          />
        )}

        <Divider />

        <VStack gap={6} xstyle={styles.narrow}>
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
      </VStack>
    </AppShell>
  );
}
