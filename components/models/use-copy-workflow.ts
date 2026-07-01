import {useMemo, useState, type Dispatch, type SetStateAction} from 'react';
import type {Model} from '@/lib/models';
import type {AsyncState} from '@/lib/async-state';
import {
  buildFileSizes,
  readCopyAndReportErrors,
  type CopyProgress,
} from '@/lib/copy-progress';
import {type CopyDestinations} from '@/components/models/copy-modal';
import {type ConflictItem} from '@/components/models/conflicts-modal';

/**
 * The copy workflow: the conflict-check → optional conflicts-modal → copy
 * pipeline, the cold-storage-resume fix, and the copy progress state. Owns the
 * per-path source resolution (`pathPresence`/`buildSourceFiles`), which nothing
 * else uses. The shared pieces it touches — the selection, the audit reset and
 * the models refresh — are passed in.
 */
export function useCopyWorkflow({
  selected,
  setSelected,
  resetAudit,
  refreshModels,
  setError,
  coldModels,
  localPeerModels,
  localPeerAddress,
  seededPeerModels,
}: {
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  resetAudit: () => void;
  refreshModels: () => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
  coldModels: Model[];
  localPeerModels: Model[];
  localPeerAddress: string | null;
  seededPeerModels: Map<string, AsyncState<Model[]>>;
}) {
  const [confirmingCopy, setConfirmingCopy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [pendingConflicts, setPendingConflicts] = useState<ConflictItem[]>([]);
  const [pendingDestinations, setPendingDestinations] =
    useState<CopyDestinations | null>(null);

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
      await readCopyAndReportErrors(res, setCopyProgress, setError);
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
      await readCopyAndReportErrors(res, setCopyProgress, setError);
      await refreshModels();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCopying(false);
      setCopyProgress(null);
    }
  }

  const cancelConflicts = () => {
    setPendingConflicts([]);
    setPendingDestinations(null);
  };

  return {
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
  };
}
