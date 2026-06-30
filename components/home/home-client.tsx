'use client';

import {useState, useMemo, useCallback} from 'react';
import {useRouter} from 'next/navigation';
import {locationHref} from '@/lib/locations';
import {AppShell} from '@astryxdesign/core/AppShell';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {Banner} from '@astryxdesign/core/Banner';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models';
import {AsyncState} from '@/lib/async-state';
import type {ModelRow} from '@/components/models/models-table-client';
import {ModelsTableClient} from '@/components/models/models-table-client';
import {
  LocationTabs,
  type LocationTab,
} from '@/components/models/location-tabs';
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
import {HuggingFaceDownload} from '@/components/hf-download/hugging-face-download';
import type {AuditResult} from '@/lib/audit';
import {Log} from '@/components/log/log';
import {ThemeToggle} from '@/components/theme/theme-toggle';

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
  const {peerModels} = usePeerModels();
  const [models, setModels] = useState(modelsTableData);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [auditResults, setAuditResults] = useState<Map<string, AuditResult>>(
    new Map(),
  );
  const [auditedPaths, setAuditedPaths] = useState<Set<string>>(new Set());
  const [auditing, setAuditing] = useState(false);
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

  const resetAudit = useCallback(() => {
    setAuditResults(new Map());
    setAuditedPaths(new Set());
  }, []);

  // Clear any selection whenever the active tab (URL) or the underlying model
  // data changes, using a render-phase reset rather than an effect.
  const [prevLocation, setPrevLocation] = useState(activeLocation);
  const [prevModels, setPrevModels] = useState(modelsTableData);
  if (prevLocation !== activeLocation || prevModels !== modelsTableData) {
    setPrevLocation(activeLocation);
    setPrevModels(modelsTableData);
    setModels(modelsTableData);
    setSelected(new Set());
    resetAudit();
  }

  const auditLocation: 'local' | 'cold-storage' | null =
    activeLocation === 'cold-storage'
      ? 'cold-storage'
      : activeLocation === localPeerAddress
        ? 'local'
        : null;

  async function onAudit() {
    if (!auditLocation) return;
    const paths = Array.from(selected);
    setAuditing(true);
    setError(null);
    setAuditedPaths(new Set(paths));
    setAuditResults(new Map());
    try {
      const res = await fetch('/api/v1/audit', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({location: auditLocation, files: paths}),
      });
      if (!res.ok || !res.body) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const result = JSON.parse(line) as AuditResult;
          setAuditResults((prev) => {
            const next = new Map(prev);
            next.set(result.file, result);
            return next;
          });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuditing(false);
    }
  }

  // Re-fetch the table data after a mutation (e.g. copy) without a full
  // server round-trip / page reload.
  async function refreshModels() {
    const res = await fetch('/api/v1/models-table');
    if (res.ok) setModels(await res.json());
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
      resetAudit();
      await refreshModels();
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
    () => selectedFileInfo(models, selected),
    [models, selected],
  );

  return (
    <AppShell contentPadding={5} height="auto">
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
        {localModelsPath && activeLocation !== 'cold-storage' && (
          <HuggingFaceDownload localModelsPath={localModelsPath} />
        )}
        <ModelsTableClient
          models={models}
          peers={peerConfigs}
          peerModels={seededPeerModels}
          selected={selected}
          onToggleSelected={onToggleSelected}
          locations={locations}
          activeLocation={activeLocation}
          auditResults={auditResults}
          auditedPaths={auditedPaths}
          auditing={auditing}
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
          onAudit={onAudit}
          auditing={auditing}
          auditSupported={auditLocation !== null}
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
      </VStack>

      <Log logLevel={logLevel} />
    </AppShell>
  );
}
