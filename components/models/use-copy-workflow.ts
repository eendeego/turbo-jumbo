import {
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type {Model} from '@/lib/models/models';
import type {AsyncState} from '@/lib/util/async-state';
import {
  readCopyAndReportErrors,
  type CopyProgress,
} from '@/lib/storage/copy-progress';
import {
  readCheckStream,
  type CheckProgress,
} from '@/lib/storage/check-progress';
import {type CopyDestinations} from '@/components/models/copy-modal';
import {type ConflictItem} from '@/components/models/conflicts-modal';

type SourceFile = {path: string; from: string; size: number};

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
  localPeerAddress,
  seededPeerModels,
}: {
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  resetAudit: () => void;
  refreshModels: () => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
  coldModels: Model[];
  localPeerAddress: string | null;
  seededPeerModels: Map<string, AsyncState<Model[]>>;
}) {
  const [confirmingCopy, setConfirmingCopy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProgress, setCheckProgress] = useState<CheckProgress | null>(
    null,
  );
  // Aborts the in-flight conflict check. The server stops between files when
  // the request is aborted, so a check that turned out to need real hashing
  // can be abandoned instead of waited out.
  const checkAbort = useRef<AbortController | null>(null);
  const [pendingConflicts, setPendingConflicts] = useState<ConflictItem[]>([]);
  const [pendingDestinations, setPendingDestinations] =
    useState<CopyDestinations | null>(null);
  // The checked file list held for the conflicts modal round-trip: the check
  // expands the selection with support files (config/tokenizer/…), and the
  // copy must send exactly the list the check reported on.
  const [pendingFiles, setPendingFiles] = useState<SourceFile[] | null>(null);

  // Per-path presence + size across cold storage, local, and remote peers, so
  // a mixed selection can name each file's own source. When a path exists in
  // several places the most complete (largest) copy wins, tie-broken by the
  // index order cold → local → remote (see `record`).
  const pathPresence = useMemo(() => {
    const sources = new Map<string, {from: string; size: number}>();
    // Prefer the most complete copy when a path exists in several places: a
    // larger copy wins, so an incomplete cold/peer copy (e.g. a transfer
    // truncated partway) is never chosen as the source for completing it
    // elsewhere — copying a smaller cold copy back over itself would just be
    // skipped. Equal sizes keep the first indexed, preserving the cold → local
    // → remote order (cold is a local mount, the cheapest source).
    const record = (path: string, size: number, from: string) => {
      const prev = sources.get(path);
      if (!prev || size > prev.size) sources.set(path, {from, size});
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
    // The local peer resolves from the same polled map the table renders
    // from (seeded from server data until the first poll lands), so anything
    // selectable is copyable — server-rendered props alone go stale the
    // moment a download finishes, and copies would silently resolve to zero
    // source files.
    if (localPeerAddress) {
      const lo = seededPeerModels.get(localPeerAddress);
      if (lo?.type === 'value') indexModels(lo.value, localPeerAddress);
    }
    for (const [addr, lo] of seededPeerModels) {
      if (addr === localPeerAddress) continue;
      if (lo.type !== 'value') continue;
      indexModels(lo.value, addr);
    }
    return sources;
  }, [coldModels, localPeerAddress, seededPeerModels]);

  function buildSourceFilesFor(paths: Iterable<string>): SourceFile[] {
    const out: SourceFile[] = [];
    for (const p of paths) {
      const entry = pathPresence.get(p);
      if (!entry) continue;
      out.push({path: p, from: entry.from, size: entry.size});
    }
    return out;
  }

  function buildSourceFiles() {
    return buildSourceFilesFor(selected);
  }

  async function onCopy(destinations: CopyDestinations) {
    setConfirmingCopy(false);
    // Refuse rather than quietly copy a subset (or nothing): every selected
    // path must resolve to a source.
    const sourceFiles = buildSourceFiles();
    if (sourceFiles.length < selected.size) {
      setError(
        'Some selected files have no known source yet — wait for the table to refresh and retry.',
      );
      return;
    }
    setChecking(true);
    setCheckProgress(null);
    setError(null);
    let hasConflicts = false;
    let hasError = false;
    let cancelled = false;
    let filesToCopy: SourceFile[] = sourceFiles;
    const abort = new AbortController();
    checkAbort.current = abort;
    try {
      const res = await fetch('/api/v1/copy/check', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: abort.signal,
        body: JSON.stringify({
          files: sourceFiles,
          toColdStorage: destinations.toColdStorage,
          toPeers: destinations.toPeers,
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      // The check streams progress and ends with its verdict; no result frame
      // means it was abandoned, and nothing should be copied.
      const result = await readCheckStream<ConflictItem, SourceFile>(
        res,
        setCheckProgress,
      );
      if (!result) {
        cancelled = true;
      } else {
        // The check expands the selection with the support files living in
        // the same model directories; the copy sends that expanded list.
        filesToCopy = result.files ?? sourceFiles;
        if (result.conflicts.length > 0) {
          hasConflicts = true;
          setPendingConflicts(result.conflicts);
          setPendingDestinations(destinations);
          setPendingFiles(filesToCopy);
        }
      }
    } catch (e) {
      if (abort.signal.aborted) {
        cancelled = true;
      } else {
        hasError = true;
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      checkAbort.current = null;
      setChecking(false);
      setCheckProgress(null);
    }
    if (!hasConflicts && !hasError && !cancelled)
      await doCopy(destinations, [], filesToCopy);
  }

  // Abandon a running check. The copy never starts: the user asked to stop.
  const cancelCheck = () => checkAbort.current?.abort();

  async function onConflictsConfirm(
    skip: Array<{file: string; destination: string}>,
  ) {
    if (!pendingDestinations) return;
    const dest = pendingDestinations;
    const files = pendingFiles ?? buildSourceFiles();
    setPendingConflicts([]);
    setPendingDestinations(null);
    setPendingFiles(null);
    await doCopy(dest, skip, files);
  }

  async function doCopy(
    destinations: CopyDestinations,
    skip: Array<{file: string; destination: string}>,
    files: SourceFile[],
  ) {
    setCopying(true);
    setCopyProgress(null);
    setError(null);
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files,
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

  // Complete a partial cold-storage copy: re-copy the affected files to cold
  // storage from their most complete copy. pathPresence resolves each file to
  // its largest copy, so the truncated cold copy loses to the full one whether
  // that lives locally or on a peer — completing the cold copy works from any
  // tab. The server resumes from the verified prefix already in cold storage, so
  // only the missing tail is transferred. Bypasses the conflict check (skip:[])
  // — overwriting the partial copy is the point.
  async function onFixColdIncomplete(paths: string[]) {
    if (paths.length === 0) return;
    // A file whose only copy is the cold one can't be completed from a copy
    // (cold → cold is a no-op); drop those so we never send an empty transfer.
    const files = buildSourceFilesFor(paths).filter(
      (f) => f.from !== 'cold-storage',
    );
    if (files.length === 0) return;
    setCopying(true);
    setCopyProgress(null);
    setError(null);
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files,
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
    setPendingFiles(null);
  };

  return {
    copying,
    copyProgress,
    checking,
    checkProgress,
    cancelCheck,
    confirmingCopy,
    setConfirmingCopy,
    pendingConflicts,
    onCopy,
    onConflictsConfirm,
    onFixColdIncomplete,
    cancelConflicts,
  };
}
