'use client';

import {useState, useMemo, useCallback, useEffect, useRef} from 'react';
import {useRouter} from 'next/navigation';
import {locationHref} from '@/lib/locations';
import {AppShell} from '@astryxdesign/core/AppShell';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Banner} from '@astryxdesign/core/Banner';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models';
import {withPeerPaths} from '@/lib/peer-paths';
import type {ModelRow} from '@/components/models/models-table-client';
import {
  ModelsTableClient,
  augmentWithPeerOnlyQuants,
} from '@/components/models/models-table-client';
import {
  LocationTabs,
  type LocationTab,
} from '@/components/models/location-tabs';
import {ActionBar} from '@/components/models/action-bar';
import {
  buildFileSizes,
  type CopyProgress,
  readCopyProgress,
} from '@/lib/copy-progress';
import {readNdjson} from '@/lib/ndjson';
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
import {useInventoryLocations} from '@/components/models/use-inventory-locations';
import {AddModelMenu} from '@/components/models/add-model-menu';
import {SetSourceModal} from '@/components/models/set-source-modal';
import {RevisionsModal} from '@/components/models/revisions-modal';
import {
  DownloadModal,
  useDownloadRunner,
} from '@/components/hf-download/download-runner';
import type {
  AuditProgressEvent,
  AuditResult,
  AuditStartEvent,
  FixResult,
  HfSummary,
  UpdateResult,
} from '@/lib/audit';
import type {DuplicateFixResult} from '@/lib/fix-duplicates';
import {Log} from '@/components/log/log';
import {ThemeToggle} from '@/components/theme/theme-toggle';

// The location's last-known audit verdicts, derived server-side from the
// `.tjmeta.json` sidecars — no hashing, no network beyond this call.
async function fetchCachedResults(location: string): Promise<AuditResult[]> {
  const res = await fetch('/api/v1/audit/cached', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({location}),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const {results} = (await res.json()) as {results: AuditResult[]};
  return results;
}

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [auditResults, setAuditResults] = useState<Map<string, AuditResult>>(
    new Map(),
  );
  const [auditedPaths, setAuditedPaths] = useState<Set<string>>(new Set());
  const [auditing, setAuditing] = useState(false);
  // Per-file SHA256 hashing progress for the in-flight audit run, keyed by
  // path; entries drop as verdicts land and the map clears when the run ends.
  const [auditProgress, setAuditProgress] = useState<
    Map<string, AuditProgressEvent>
  >(new Map());
  // Files whose audit job has been picked up this run. In-flight paths absent
  // from this set are still queued (audits serialize on cold storage).
  const [auditStarted, setAuditStarted] = useState<Set<string>>(new Set());
  // Per-file "newer version on HF" results for the current location, filled by
  // the background update check after cached verdicts render. Keyed by path.
  const [updateResults, setUpdateResults] = useState<Map<string, UpdateResult>>(
    new Map(),
  );
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixingDuplicate, setFixingDuplicate] = useState(false);
  // The file whose HF source is being set (relative path), plus the request
  // state for the modal.
  const [sourceTarget, setSourceTarget] = useState<string | null>(null);
  const [settingSource, setSettingSource] = useState(false);
  // SHA256 progress of the verification running in the Set source modal.
  const [sourceProgress, setSourceProgress] =
    useState<AuditProgressEvent | null>(null);
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
    setAuditProgress(new Map());
    setAuditStarted(new Set());
    setUpdateResults(new Map());
    setCheckingUpdates(false);
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

  // Where audit requests go: this host's storage ('local'/'cold-storage') or
  // a remote peer's address, which the server proxies to that peer. Only the
  // aggregate view can't be audited.
  const auditLocation: string | null =
    activeLocation === 'all'
      ? null
      : activeLocation === localPeerAddress
        ? 'local'
        : activeLocation;

  const runAudit = useCallback(
    async (paths: string[]) => {
      if (!auditLocation || paths.length === 0) return;
      setAuditing(true);
      setError(null);
      // Show the location's full cached state up front: every file's
      // last-known (sidecar) verdict renders before any hashing starts, and
      // the submitted paths revert from fresh to cached — the run's live
      // signals then override them row by row (see rowAudit). When the cached
      // fetch fails, the submitted paths just show pending, as before.
      let cached: AuditResult[] = [];
      try {
        cached = await fetchCachedResults(auditLocation);
      } catch {
        /* best-effort pre-seed */
      }
      const cachedByFile = new Map(cached.map((r) => [r.file, r]));
      setAuditedPaths(
        (prev) => new Set([...prev, ...paths, ...cachedByFile.keys()]),
      );
      setAuditResults((prev) => {
        const next = new Map(prev);
        for (const p of paths) {
          const c = cachedByFile.get(p);
          if (c) next.set(p, c);
          else next.delete(p);
        }
        for (const r of cached) if (!next.has(r.file)) next.set(r.file, r);
        return next;
      });
      // Everything submitted starts out queued, until its start event arrives.
      setAuditStarted(new Set());
      try {
        const res = await fetch('/api/v1/audit', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({location: auditLocation, files: paths}),
        });
        if (!res.ok || !res.body) {
          throw new Error(`${res.status} ${res.statusText}`);
        }
        await readNdjson<AuditResult | AuditProgressEvent | AuditStartEvent>(
          res,
          (event) => {
            if ('status' in event) {
              setAuditResults((prev) => {
                const next = new Map(prev);
                next.set(event.file, event);
                return next;
              });
              // Register streamed verdicts whose path wasn't in the selection
              // (e.g. a synthetic missing-mmproj verdict), so rowAudit — which
              // filters by auditedPaths — picks them up.
              setAuditedPaths((prev) =>
                prev.has(event.file) ? prev : new Set(prev).add(event.file),
              );
              // The verdict supersedes any hashing progress for the file.
              setAuditProgress((prev) => {
                if (!prev.has(event.file)) return prev;
                const next = new Map(prev);
                next.delete(event.file);
                return next;
              });
            } else if ('hashedBytes' in event) {
              setAuditProgress((prev) => new Map(prev).set(event.file, event));
            } else if ('started' in event) {
              setAuditStarted((prev) => new Set(prev).add(event.file));
            }
          },
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setAuditing(false);
        setAuditProgress(new Map());
        setAuditStarted(new Set());
      }
    },
    [auditLocation],
  );

  // Fold cached verdicts into the audit state without clobbering fresh
  // results — a fresh verdict is always at least as current as its sidecar.
  const seedCachedResults = useCallback((results: AuditResult[]) => {
    if (results.length === 0) return;
    setAuditResults((prev) => {
      const next = new Map(prev);
      for (const r of results) if (!next.has(r.file)) next.set(r.file, r);
      return next;
    });
    setAuditedPaths(
      (prev) => new Set([...prev, ...results.map((r) => r.file)]),
    );
  }, []);

  // With files selected, Audit runs a fresh audit of them; with none, it
  // loads and renders the location's cached verdicts for every file.
  const onAudit = () => {
    if (selected.size > 0) {
      void runAudit(Array.from(selected));
    } else {
      void loadCachedAudits();
    }
  };

  async function loadCachedAudits() {
    if (!auditLocation) return;
    setAuditing(true);
    setError(null);
    try {
      seedCachedResults(await fetchCachedResults(auditLocation));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuditing(false);
    }
    // Cached verdicts are network-free; now check HF for newer versions in the
    // background, updating rows as results stream in.
    void checkUpdates();
  }

  // Network-only "is there a newer version on HF?" pass over the location's
  // files. Streams per-file verdicts; only files behind their repo head are
  // reported as updates. Failures are non-fatal — cached verdicts stay.
  async function checkUpdates() {
    if (!auditLocation) return;
    setCheckingUpdates(true);
    try {
      const res = await fetch('/api/v1/audit/updates', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({location: auditLocation}),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await readNdjson<UpdateResult>(res, (event) => {
        setUpdateResults((prev) => new Map(prev).set(event.file, event));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingUpdates(false);
    }
  }

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
  // Resolution errors come back as plain JSON; once verification starts the
  // response streams hashing progress (shown in the modal), then the verdict.
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
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setSourceError(data?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      // Held in an object property: TS doesn't track assignments made inside
      // the callback, so a plain `let` would narrow to null at the read below.
      const got: {verdict: AuditResult | null} = {verdict: null};
      await readNdjson<AuditResult | AuditProgressEvent>(res, (event) => {
        if ('status' in event) got.verdict = event;
        else if ('hashedBytes' in event) setSourceProgress(event);
      });
      const result = got.verdict;
      if (!result) {
        setSourceError('verification ended without a verdict');
        return;
      }
      setAuditedPaths((prev) => new Set(prev).add(result.file));
      setAuditResults((prev) => new Map(prev).set(result.file, result));
      setSourceTarget(null);
    } catch (e) {
      setSourceError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettingSource(false);
      setSourceProgress(null);
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
        const results = await fetchCachedResults(auditLocation);
        if (!cancelled) seedCachedResults(results);
      } catch {
        /* best-effort pre-fill */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auditLocation, seedCachedResults]);

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

  async function onDelete(dryRun: boolean) {
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
      // Force an immediate rescan everywhere the table reads from instead of
      // waiting for the next poll. refreshModels() refreshes the models state
      // (the local + cold storage rows) and router.refresh() re-renders the
      // server component (the cold-storage and local-models props), but the
      // table also filters and synthesizes peer-tab rows from the client-polled
      // peerModels map, which neither touches — so rescan every affected peer
      // too. Run them together so the row drops as soon as the scans return.
      const peersToRescan =
        activeLocation === 'all'
          ? peerConfigs
          : activeLocation === 'cold-storage'
            ? []
            : peerConfigs.filter((p) => p.address === activeLocation);
      router.refresh();
      await Promise.all([
        refreshModels(),
        ...peersToRescan.map((p) => refreshPeerModels(p)),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

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
          files: buildSourceFiles(),
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
          files: buildSourceFiles(),
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
      // Sources are local by construction: this re-runs the local → cold copy.
      const sizes = buildFileSizes(localPeerModels);
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: paths.map((p) => ({
            path: p,
            from: localPeerAddress,
            size: sizes[p] ?? 0,
          })),
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

  // Per-path presence + size across cold storage, local, and remote peers, so
  // a mixed selection can name each file's own source. Preference order when
  // a path exists in multiple places: cold → local → remote.
  const pathPresence = useMemo(() => {
    const sources = new Map<string, {from: string; size: number}>();
    const record = (path: string, size: number, from: string) => {
      if (!sources.has(path)) sources.set(path, {from, size});
    };
    const indexModels = (list: Model[], from: string) => {
      for (const m of list) {
        for (const f of m.files) {
          if (f.isSplit) {
            for (const shard of f.files) record(shard.path, shard.size, from);
          } else {
            record(f.path, f.size, from);
          }
        }
      }
    };
    indexModels(coldModels, 'cold-storage');
    if (localPeerAddress) indexModels(localPeerModels, localPeerAddress);
    for (const [addr, lo] of seededPeerModels) {
      if (addr === localPeerAddress) continue;
      if (lo.type !== 'value') continue;
      indexModels(lo.value, addr);
    }
    return sources;
  }, [coldModels, localPeerModels, localPeerAddress, seededPeerModels]);

  function buildSourceFiles(): Array<{
    path: string;
    from: string;
    size: number;
  }> {
    const out: Array<{path: string; from: string; size: number}> = [];
    for (const p of selected) {
      const entry = pathPresence.get(p);
      if (!entry) continue;
      out.push({path: p, from: entry.from, size: entry.size});
    }
    return out;
  }

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

  const fileInfo = useMemo(
    () => selectedFileInfo(augmentedModels, selected),
    [augmentedModels, selected],
  );

  // Downloads run only on the local machine, so the Add model menu is enabled
  // on the local peer and the All tab, but not on a remote peer's tab.
  const isLocal = activeLocation === localPeerAddress;
  const canDownloadLocally = activeLocation === 'all' || isLocal;

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
        {localModelsPath && canDownloadLocally && (
          <HStack hAlign="end">
            <AddModelMenu
              activeLocation={activeLocation}
              peerConfigs={peerConfigs}
            />
          </HStack>
        )}
        {checkingUpdates && (
          <Text type="supporting">Checking Hugging Face for updates…</Text>
        )}
        <ModelsTableClient
          models={tableModels}
          peers={peerConfigs}
          peerModels={seededPeerModels}
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
            progress={sourceProgress}
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
            command={redownload.command ?? undefined}
            hfTokenSet={hfTokenSet}
            onClose={closeRedownload}
          />
        )}
      </VStack>

      <Log logLevel={logLevel} />
    </AppShell>
  );
}
