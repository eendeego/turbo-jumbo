'use client';

import {useState, useMemo, useCallback, useEffect, useRef} from 'react';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Banner} from '@astryxdesign/core/Banner';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models';
import {fileJoinKey, fileSizesByKey, withPeerPaths} from '@/lib/peer-paths';
import type {ModelRow} from '@/components/models/models-table-client';
import {
  ModelsTableClient,
  augmentWithPeerOnlyQuants,
} from '@/components/models/models-table-client';
import {type LocationTab} from '@/components/models/location-tabs';
import {ActionBar} from '@/components/models/action-bar';
import {
  DeleteModal,
  anyMissingFromColdStorage,
  type FileInfo,
} from '@/components/models/delete-modal';
import {CopyModal} from '@/components/models/copy-modal';
import {ConflictsModal} from '@/components/models/conflicts-modal';
import {useInventoryLocations} from '@/components/models/use-inventory-locations';
import {useCopyWorkflow} from '@/components/models/use-copy-workflow';
import {useDeleteWorkflow} from '@/components/models/use-delete-workflow';
import {useAuditWorkflow} from '@/components/models/use-audit-workflow';
import {SetSourceModal} from '@/components/models/set-source-modal';
import {RevisionsModal} from '@/components/models/revisions-modal';
import {
  DownloadModal,
  useDownloadRunner,
} from '@/components/hf-download/download-runner';
import type {AuditResult, HfSummary} from '@/lib/audit';
import {useConsole} from '@/components/chrome/console-context';

// A stable empty set, so locations with no incomplete repos don't hand the
// table a fresh reference each render.
const EMPTY_SET: Set<string> = new Set();

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
  sourceSizeByKey: Map<string, number>,
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
          // The source size, so a smaller cold-storage/peer copy (an incomplete
          // transfer) isn't treated as already present — a single file joins to
          // one destination key, so its size compares directly. Use the largest
          // copy known across locations, not q.size: a row built from a
          // truncated cold copy carries that truncated size, which would hide
          // that a peer holds the complete file. A split's representative name
          // would compare against a single shard, so leave size off for splits
          // (presence falls back to name-only).
          ...(q.isSingleFile
            ? {
                size:
                  sourceSizeByKey.get(fileJoinKey(model.name, q.displayName)) ??
                  q.size,
              }
            : {}),
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
  modelsTableData,
  peerConfigs,
  localPeerAddress,
  localPeerModels,
}: {
  activeLocation: string;
  coldModels: Model[];
  localModelsPath: string | null;
  hfTokenSet: boolean;
  modelsTableData: ModelRow[];
  peerConfigs: PeerConfig[];
  localPeerAddress: string | null;
  localPeerModels: Model[];
}) {
  const {peerModels, handleModelsRefreshed, seededPeerModels} =
    useInventoryLocations({
      peerConfigs,
      localPeerAddress,
      localPeerModels,
      coldModels,
    });

  // Re-fetch a peer's models and push the result into the polled map, so a
  // mutation (download finishing, a delete) is reflected immediately instead
  // of lingering until the next poll. The table's per-peer row set is driven
  // by this polled map, not by server-rendered props, so router.refresh()
  // alone can't update it.
  const refreshPeerModels = useCallback(
    async (peer: PeerConfig) => {
      try {
        const res = await fetch(
          `/api/v1/peers/${encodeURIComponent(peer.name)}/models`,
        );
        if (!res.ok) return;
        const models = (await res.json()) as Model[];
        handleModelsRefreshed(peer.address, models);
      } catch {
        /* best-effort: the periodic poll will catch up */
      }
    },
    [handleModelsRefreshed],
  );

  const [models, setModels] = useState(modelsTableData);
  // Per-peer repo ids whose local copy is incomplete (present but missing
  // files a full download would include); drives the table's incomplete marker.
  const [incompleteByPeer, setIncompleteByPeer] = useState<
    Map<string, Set<string>>
  >(new Map());
  const refreshIncomplete = useCallback(async () => {
    const entries = await Promise.all(
      peerConfigs.map(async (p) => {
        try {
          const res = await fetch(
            `/api/v1/peers/${encodeURIComponent(p.name)}/incomplete`,
          );
          if (!res.ok) return [p.address, new Set<string>()] as const;
          const data = (await res.json()) as {incomplete?: string[]};
          return [p.address, new Set(data.incomplete ?? [])] as const;
        } catch {
          return [p.address, new Set<string>()] as const;
        }
      }),
    );
    setIncompleteByPeer(new Map(entries));
  }, [peerConfigs]);
  // Per-peer repo ids with at least one invalid local file (present but corrupt
  // or unverifiable); drives the table's invalid marker, parallel to incomplete.
  const [invalidByPeer, setInvalidByPeer] = useState<Map<string, Set<string>>>(
    new Map(),
  );
  const refreshInvalid = useCallback(async () => {
    const entries = await Promise.all(
      peerConfigs.map(async (p) => {
        try {
          const res = await fetch(
            `/api/v1/peers/${encodeURIComponent(p.name)}/invalid`,
          );
          if (!res.ok) return [p.address, new Set<string>()] as const;
          const data = (await res.json()) as {invalid?: string[]};
          return [p.address, new Set(data.invalid ?? [])] as const;
        } catch {
          return [p.address, new Set<string>()] as const;
        }
      }),
    );
    setInvalidByPeer(new Map(entries));
  }, [peerConfigs]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // The global console (logs) lives in the layout shell; read its open state so
  // the action bar's Console button can toggle it.
  const {open: consoleOpen, toggle: toggleConsole} = useConsole();

  const locations: LocationTab[] = useMemo(
    () =>
      peerConfigs.map((p) => ({
        id: p.address,
        label: p.name,
        isLocal: p.isLocal ?? false,
      })),
    [peerConfigs],
  );

  // Where audit requests go: this host's storage ('local'/'cold-storage') or
  // a remote peer's address, which the server proxies to that peer. Only the
  // aggregate view can't be audited.
  const auditLocation: string | null =
    activeLocation === 'all'
      ? null
      : activeLocation === localPeerAddress
        ? 'local'
        : activeLocation;

  // The audit workflow (run/cached/update, the misplaced + duplicate fixes,
  // and the set-source flow) lives in its own hook; it owns the audit-result
  // state and touches the shared selection / models refresh / error.
  const {
    auditResults,
    auditedPaths,
    auditing,
    auditProgress,
    auditStarted,
    updateResults,
    checkingUpdates,
    fixing,
    fixingDuplicate,
    sourceTarget,
    settingSource,
    sourceError,
    sourceProgress,
    resetAudit,
    runAudit,
    onAudit,
    onFix,
    onFixDuplicate,
    onSetSource,
    submitSource,
    misplacedPaths,
    cancelSetSource,
  } = useAuditWorkflow({
    auditLocation,
    selected,
    setSelected,
    refreshModels,
    setError,
  });

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

  useEffect(() => {
    (async () => {
      await refreshIncomplete();
    })();
  }, [refreshIncomplete]);
  useEffect(() => {
    (async () => {
      await refreshInvalid();
    })();
  }, [refreshInvalid]);

  // Re-fetch the table data after a mutation (e.g. copy) without a full
  // server round-trip / page reload.
  async function refreshModels() {
    const res = await fetch('/api/v1/models-table');
    if (res.ok) setModels(await res.json());
  }

  // The audit failure whose checked revisions are shown in a modal, if any.
  const [revisionsFile, setRevisionsFile] = useState<AuditResult | null>(null);

  // Redownload an incomplete file: re-fetch from HF into local storage. The
  // existing partial file is left in place so the HF downloader recovers it
  // (never deleted, never sent to cold storage here).
  const redownload = useDownloadRunner(localModelsPath ?? '');
  const [redownloadOpen, setRedownloadOpen] = useState(false);
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
      setRedownloadOpen(true);
      redownload.start(req);
    },
    [redownload],
  );

  // Download a whole-repo model's invalid + missing files (from the audit
  // hovercard). Reuses the redownload runner/modal; the HF downloader overwrites
  // an invalid copy in place and fills in any missing file.
  const onDownloadRepoFiles = useCallback(
    (repoId: string, repoPaths: string[]) => {
      if (repoPaths.length === 0) return;
      redownloadPath.current = null; // multi-file: refresh-all on close, no single re-audit
      setError(null);
      setRedownloadOpen(true);
      redownload.start({repoId, branch: 'main', filePaths: repoPaths});
    },
    [redownload],
  );

  // Not a useCallback: it closes over runAudit (from the audit hook), whose
  // identity the React Compiler can't reconcile with a manual deps array — so
  // let the compiler memoize it instead.
  const closeRedownload = () => {
    if (redownload.running) redownload.cancel();
    setRedownloadOpen(false);
    redownload.reset();
    const path = redownloadPath.current;
    redownloadPath.current = null;
    // Reflect the recovered file(s): refresh the listing, the invalid/incomplete
    // flags, and re-audit a single recovered file when we know which it was.
    void refreshModels();
    void refreshInvalid();
    void refreshIncomplete();
    if (path && auditLocation === 'local') void runAudit([path]);
  };

  const onToggleSelected = useCallback((paths: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = paths.every((p) => next.has(p));
      if (allSelected) paths.forEach((p) => next.delete(p));
      else paths.forEach((p) => next.add(p));
      return next;
    });
  }, []);

  // The delete workflow (the confirm flag, the fan-out delete and rescan, and
  // the "delete from <where>" label) lives in its own hook.
  const {confirming, setConfirming, deleting, deleteFromLabel, onDelete} =
    useDeleteWorkflow({
      selected,
      setSelected,
      activeLocation,
      peerConfigs,
      refreshModels,
      refreshPeerModels,
      refreshIncomplete,
      refreshInvalid,
      setError,
    });

  // The copy workflow (conflict check → copy, cold-storage resume fix, and the
  // copy progress state) lives in its own hook; it owns the per-path source
  // resolution and touches the shared selection / audit reset / models refresh.
  const {
    copying,
    copyProgress,
    checking,
    confirmingCopy,
    setConfirmingCopy,
    pendingConflicts,
    onCopy,
    onConflictsConfirm,
    onFixColdIncomplete,
    cancelConflicts,
  } = useCopyWorkflow({
    selected,
    setSelected,
    resetAudit,
    refreshModels,
    setError,
    coldModels,
    localPeerModels,
    localPeerAddress,
    seededPeerModels,
  });

  // On a remote peer's tab, quants must carry the peer's own paths: audit,
  // copy and delete all resolve paths on the peer, whose storage layout can
  // differ from the local one.
  const tableModels = useMemo(() => {
    const peer = peerConfigs.find(
      (p) => p.address === activeLocation && !p.isLocal,
    );
    if (!peer) return models;
    const lo = peerModels.get(peer.address);
    if (!lo || lo.type !== 'value') return models;
    return withPeerPaths(models, lo.value);
  }, [models, peerConfigs, activeLocation, peerModels]);

  // Selections can name peer-only quants (rows the table synthesizes), so the
  // copy/delete modals must resolve against the same augmented view.
  const augmentedModels = useMemo(
    () => augmentWithPeerOnlyQuants(tableModels, seededPeerModels),
    [tableModels, seededPeerModels],
  );

  // The largest copy of each file known across cold storage, local, and every
  // peer, keyed by fileJoinKey (matching allFilesPresent). A row built from a
  // truncated cold/local copy reports that truncated size as its quant size, so
  // the copy modal's "already in cold storage" check needs the true (complete)
  // size from wherever the full copy lives — otherwise a peer's full file can't
  // be copied over a truncated cold copy.
  const sourceSizeByKey = useMemo(() => {
    const max = new Map<string, number>();
    const merge = (list: Model[]) => {
      for (const [key, size] of fileSizesByKey(list)) {
        const prev = max.get(key);
        if (prev == null || size > prev) max.set(key, size);
      }
    };
    merge(coldModels);
    merge(localPeerModels);
    for (const lo of seededPeerModels.values()) {
      if (lo.type === 'value') merge(lo.value);
    }
    return max;
  }, [coldModels, localPeerModels, seededPeerModels]);

  const fileInfo = useMemo(
    () => selectedFileInfo(augmentedModels, selected, sourceSizeByKey),
    [augmentedModels, selected, sourceSizeByKey],
  );

  // Incomplete repos for the table's current view: a single location's set, or
  // the union across all of them on the All tab.
  const activeIncomplete = useMemo(() => {
    if (activeLocation === 'all') {
      const union = new Set<string>();
      for (const s of incompleteByPeer.values())
        for (const r of s) union.add(r);
      return union;
    }
    return incompleteByPeer.get(activeLocation) ?? EMPTY_SET;
  }, [incompleteByPeer, activeLocation]);

  // Invalid repos for the table's current view: a single location's set, or the
  // union across all of them on the All tab. Mirrors activeIncomplete.
  const activeInvalid = useMemo(() => {
    if (activeLocation === 'all') {
      const union = new Set<string>();
      for (const s of invalidByPeer.values()) for (const r of s) union.add(r);
      return union;
    }
    return invalidByPeer.get(activeLocation) ?? EMPTY_SET;
  }, [invalidByPeer, activeLocation]);

  return (
    <>
      <Layout
        height="fill"
        content={
          // The table is the single scroll region: it fills this
          // non-scrollable content area and scrolls internally (its root is
          // already overflow:auto), which lets its sticky <thead> pin to the
          // top while the rows scroll. See the .tj-models-pane rule in
          // globals.css.
          <LayoutContent
            className="tj-models-pane"
            isScrollable={false}
            padding={0}
          >
            <ModelsTableClient
              models={tableModels}
              peers={peerConfigs}
              peerModels={seededPeerModels}
              incompleteRepos={activeIncomplete}
              invalidRepos={activeInvalid}
              selected={selected}
              onToggleSelected={onToggleSelected}
              locations={locations}
              activeLocation={activeLocation}
              auditResults={auditResults}
              auditedPaths={auditedPaths}
              auditing={auditing}
              auditProgress={auditProgress}
              auditStarted={auditStarted}
              updateResults={updateResults}
              onClearAudit={resetAudit}
              onFixMisplaced={onFix}
              fixing={fixing}
              onFixDuplicate={onFixDuplicate}
              fixingDuplicate={fixingDuplicate}
              onSetSource={onSetSource}
              onRedownload={
                auditLocation === 'local' ? onRedownload : undefined
              }
              onDownloadRepoFiles={
                auditLocation === 'local' ? onDownloadRepoFiles : undefined
              }
              onShowRevisions={setRevisionsFile}
              redownloading={redownload.running}
              onFixColdIncomplete={
                localPeerAddress ? onFixColdIncomplete : undefined
              }
              coldFixing={copying}
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <VStack gap={2}>
              {checkingUpdates && (
                <Text type="supporting">
                  Checking Hugging Face for updates…
                </Text>
              )}
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
                consoleOpen={consoleOpen}
                onToggleConsole={toggleConsole}
              />
            </VStack>
          </LayoutFooter>
        }
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
          showKeepCold={activeLocation === 'all'}
          onConfirm={onDelete}
          onCancel={() => setConfirming(false)}
        />
      )}
      {confirmingCopy && (
        <CopyModal
          files={fileInfo}
          from={activeLocation}
          onCopy={onCopy}
          onCancel={() => setConfirmingCopy(false)}
        />
      )}
      {pendingConflicts.length > 0 && (
        <ConflictsModal
          conflicts={pendingConflicts}
          peers={peerConfigs}
          onConfirm={onConflictsConfirm}
          onCancel={cancelConflicts}
        />
      )}
      {sourceTarget && (
        <SetSourceModal
          filename={sourceTarget.split('/').pop() ?? sourceTarget}
          busy={settingSource}
          error={sourceError}
          progress={sourceProgress}
          onSubmit={submitSource}
          onCancel={cancelSetSource}
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
          command={redownload.command ?? undefined}
          hfTokenSet={hfTokenSet}
          onClose={closeRedownload}
        />
      )}
    </>
  );
}
