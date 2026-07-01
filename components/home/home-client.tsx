'use client';

import {useState, useMemo, useCallback, useEffect, useRef} from 'react';
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
import {SetSourceModal} from '@/components/models/set-source-modal';
import {RevisionsModal} from '@/components/models/revisions-modal';
import {
  DownloadModal,
  buildHfCommand,
  useDownloadRunner,
} from '@/components/hf-download/download-runner';
import type {AuditResult, FixResult, HfSummary} from '@/lib/audit';
import type {DuplicateFixResult} from '@/lib/fix-duplicates';
import {Log} from '@/components/log/log';
import {ThemeToggle} from '@/components/theme/theme-toggle';

// Derive the redownload target (repo, branch, in-repo path) from an audited
// file's HF summary. The branch and in-repo path come from the file URL; the
// repo from the summary directly.
function fileRefFromSummary(
  hf: HfSummary,
): {repoId: string; branch: string; repoPath: string} | null {
  const m = hf.fileUrl.match(
    /^https?:\/\/huggingface\.co\/[^/]+\/[^/]+\/(?:blob|resolve)\/([^/]+)\/(.+)$/,
  );
  if (!m) return null;
  return {repoId: hf.repoId, branch: m[1], repoPath: m[2]};
}

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
  hfTokenSet,
  logLevel,
  modelsTableData,
  peerConfigs,
  localPeerAddress,
  localPeerModels,
}: {
  activeLocation: string;
  coldModels: Model[];
  localModelsPath: string | null;
  hfTokenSet: boolean;
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
  const [fixing, setFixing] = useState(false);
  const [fixingDuplicate, setFixingDuplicate] = useState(false);
  // The file whose HF source is being set (relative path), plus the request
  // state for the modal.
  const [sourceTarget, setSourceTarget] = useState<string | null>(null);
  const [settingSource, setSettingSource] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
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

  const runAudit = useCallback(
    async (paths: string[]) => {
      if (!auditLocation || paths.length === 0) return;
      setAuditing(true);
      setError(null);
      // Accumulate across runs: keep prior verdicts and merge in the new paths,
      // clearing only the in-flight paths so they show "Auditing…" as they
      // stream.
      setAuditedPaths((prev) => new Set([...prev, ...paths]));
      setAuditResults((prev) => {
        const next = new Map(prev);
        for (const p of paths) next.delete(p);
        return next;
      });
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
    },
    [auditLocation],
  );

  const onAudit = () => runAudit(Array.from(selected));

  // Re-fetch the table data after a mutation (e.g. copy) without a full
  // server round-trip / page reload.
  async function refreshModels() {
    const res = await fetch('/api/v1/models-table');
    if (res.ok) setModels(await res.json());
  }

  // Relocate misplaced files into <repoId>/<repoPath>. The moved files keep
  // their verified size/sha, so we mark them passing and remap state to the new
  // paths in place rather than re-hashing.
  async function onFix(paths: string[]) {
    if (!auditLocation || paths.length === 0) return;
    setFixing(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/audit/fix', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({location: auditLocation, files: paths}),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const {results} = (await res.json()) as {results: FixResult[]};

      const moved = results.filter(
        (r): r is FixResult & {to: string} => r.status === 'moved' && !!r.to,
      );
      if (moved.length > 0) {
        setAuditResults((prev) => {
          const next = new Map(prev);
          for (const m of moved) {
            next.delete(m.file);
            next.set(m.to, {file: m.to, status: 'pass'});
          }
          return next;
        });
        setAuditedPaths((prev) => {
          const next = new Set(prev);
          for (const m of moved) {
            next.delete(m.file);
            next.add(m.to);
          }
          return next;
        });
        setSelected((prev) => {
          const next = new Set(prev);
          for (const m of moved) {
            if (next.delete(m.file)) next.add(m.to);
          }
          return next;
        });
        await refreshModels();
      }

      const failed = results.filter((r) => r.status === 'error');
      if (failed.length > 0) {
        setError(
          `Fix failed for ${failed.length} file(s): ${failed
            .map((f) => `${f.file} (${f.message})`)
            .join('; ')}`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFixing(false);
    }
  }

  // Resolve duplicate groups server-side (see /api/v1/audit/fix-duplicate):
  // losers are deleted, the surviving copy — just re-verified by hash — ends
  // at its expected path, so it's marked passing at its new location.
  async function onFixDuplicate(paths: string[]) {
    if (!auditLocation || paths.length === 0) return;
    setFixingDuplicate(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/audit/fix-duplicate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({location: auditLocation, files: paths}),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const {results} = (await res.json()) as {results: DuplicateFixResult[]};

      const deleted = results.filter((r) => r.status === 'deleted');
      const kept = results.filter((r) => r.status === 'kept');
      if (deleted.length > 0 || kept.length > 0) {
        setAuditResults((prev) => {
          const next = new Map(prev);
          for (const d of deleted) next.delete(d.file);
          for (const k of kept) {
            next.delete(k.file);
            const at = k.to ?? k.file;
            next.set(at, {file: at, status: 'pass'});
          }
          return next;
        });
        setAuditedPaths((prev) => {
          const next = new Set(prev);
          for (const d of deleted) next.delete(d.file);
          for (const k of kept) {
            next.delete(k.file);
            next.add(k.to ?? k.file);
          }
          return next;
        });
        setSelected((prev) => {
          const next = new Set(prev);
          for (const d of deleted) next.delete(d.file);
          for (const k of kept) {
            if (next.delete(k.file)) next.add(k.to ?? k.file);
          }
          return next;
        });
        await refreshModels();
      }

      const failed = results.filter((r) => r.status === 'error');
      if (failed.length > 0) {
        setError(
          `Duplicate fix failed for ${failed.length} file(s): ${failed
            .map((f) => `${f.file} (${f.message})`)
            .join(', ')}`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFixingDuplicate(false);
    }
  }

  // Open the "set source" modal for an unverifiable file.
  const onSetSource = useCallback((path: string) => {
    setSourceError(null);
    setSourceTarget(path);
  }, []);

  // The audit failure whose checked revisions are shown in a modal, if any.
  const [revisionsFile, setRevisionsFile] = useState<AuditResult | null>(null);

  // Redownload an incomplete file: re-fetch from HF into local storage. The
  // existing partial file is left in place so the HF downloader recovers it
  // (never deleted, never sent to cold storage here).
  const redownload = useDownloadRunner();
  const [redownloadOpen, setRedownloadOpen] = useState(false);
  const [redownloadCommand, setRedownloadCommand] = useState<string | null>(
    null,
  );
  const redownloadPath = useRef<string | null>(null);

  const onRedownload = useCallback(
    (file: AuditResult) => {
      if (!file.hf) return;
      const ref = fileRefFromSummary(file.hf);
      if (!ref) {
        setError(`Couldn't determine a download source for ${file.file}`);
        return;
      }
      redownloadPath.current = file.hf.expectedPath; // where the file lands
      const req = {
        repoId: ref.repoId,
        branch: ref.branch,
        filePaths: [ref.repoPath],
      };
      setError(null);
      setRedownloadCommand(
        localModelsPath ? buildHfCommand(req, localModelsPath) : null,
      );
      setRedownloadOpen(true);
      redownload.start(req);
    },
    [redownload, localModelsPath],
  );

  const closeRedownload = useCallback(() => {
    if (redownload.running) redownload.cancel();
    setRedownloadOpen(false);
    redownload.reset();
    const path = redownloadPath.current;
    redownloadPath.current = null;
    // Reflect the recovered file: refresh the listing and re-audit just it.
    void refreshModels();
    if (path && auditLocation === 'local') void runAudit([path]);
  }, [redownload, auditLocation, runAudit]);

  // Resolve a manually-supplied HF URL, verify the file against it, and fold the
  // resulting verdict back into the audit state (same shape as a fresh audit).
  async function submitSource(url: string) {
    if (!auditLocation || !sourceTarget) return;
    setSettingSource(true);
    setSourceError(null);
    try {
      const res = await fetch('/api/v1/audit/set-source', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          location: auditLocation,
          file: sourceTarget,
          url,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        result?: AuditResult;
        error?: string;
      } | null;
      if (!res.ok) {
        setSourceError(data?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      const result = data?.result;
      if (result) {
        setAuditedPaths((prev) => new Set(prev).add(result.file));
        setAuditResults((prev) => new Map(prev).set(result.file, result));
      }
      setSourceTarget(null);
    } catch (e) {
      setSourceError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettingSource(false);
    }
  }

  // Only freshly-audited misplaced files are fixable; cached verdicts are
  // tentative until re-audited.
  const misplacedPaths = useMemo(
    () =>
      [...auditResults.values()]
        .filter((r) => r.status === 'misplaced' && !r.cached)
        .map((r) => r.file),
    [auditResults],
  );

  // Pre-fill the Audit column from sidecar metadata so the last-known verdicts
  // show (toned down) before a fresh run. Seeds without clobbering fresh
  // results, and reloads when switching to a different local/cold tab.
  useEffect(() => {
    if (!auditLocation) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/audit/cached', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({location: auditLocation}),
        });
        if (!res.ok) return;
        const {results} = (await res.json()) as {results: AuditResult[]};
        if (cancelled || results.length === 0) return;
        setAuditResults((prev) => {
          const next = new Map(prev);
          for (const r of results) if (!next.has(r.file)) next.set(r.file, r);
          return next;
        });
        setAuditedPaths(
          (prev) => new Set([...prev, ...results.map((r) => r.file)]),
        );
      } catch {
        /* best-effort pre-fill */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auditLocation]);

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

  // Complete a partial cold-storage copy: re-run the local → cold copy for the
  // affected files. The server resumes from the verified prefix already in cold
  // storage, so only the missing tail is transferred. Bypasses the conflict
  // check — overwriting the partial copy is the point.
  async function onFixColdIncomplete(paths: string[]) {
    if (!localPeerAddress || paths.length === 0) return;
    setCopying(true);
    setCopyProgress(null);
    setError(null);
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: paths,
          from: localPeerAddress,
          toColdStorage: true,
          toPeers: [],
          deleteAfterCopy: false,
          skip: [],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await readCopyProgress(res, setCopyProgress);
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
          <HuggingFaceDownload
            localModelsPath={localModelsPath}
            hfTokenSet={hfTokenSet}
          />
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
          onFixMisplaced={onFix}
          fixing={fixing}
          onSetSource={onSetSource}
          onRedownload={auditLocation === 'local' ? onRedownload : undefined}
          onShowRevisions={setRevisionsFile}
          redownloading={redownload.running}
          onFixColdIncomplete={
            localPeerAddress ? onFixColdIncomplete : undefined
          }
          coldFixing={copying}
          onFixDuplicate={onFixDuplicate}
          fixingDuplicate={fixingDuplicate}
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
          onFixMisplaced={() => onFix(misplacedPaths)}
          misplacedCount={misplacedPaths.length}
          fixing={fixing}
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
        {sourceTarget && (
          <SetSourceModal
            filename={sourceTarget.split('/').pop() ?? sourceTarget}
            busy={settingSource}
            error={sourceError}
            onSubmit={submitSource}
            onCancel={() => {
              setSourceTarget(null);
              setSourceError(null);
            }}
          />
        )}
        {revisionsFile && (
          <RevisionsModal
            file={revisionsFile}
            onClose={() => setRevisionsFile(null)}
          />
        )}
        {redownloadOpen && (
          <DownloadModal
            title="Redownloading…"
            term={redownload.term}
            progress={redownload.progress}
            running={redownload.running}
            command={redownloadCommand ?? undefined}
            hfTokenSet={hfTokenSet}
            onClose={closeRedownload}
          />
        )}
      </VStack>

      <Log logLevel={logLevel} />
    </AppShell>
  );
}
