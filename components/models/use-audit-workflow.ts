import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {readNdjson} from '@/lib/util/ndjson';
import type {
  AuditProgressEvent,
  AuditResult,
  AuditStartEvent,
  FixResult,
  UpdateResult,
} from '@/lib/audit/audit';
import type {DuplicateFixResult} from '@/lib/audit/fix-duplicates';

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

/**
 * The audit workflow: running a fresh audit (streaming verdicts + hashing
 * progress), seeding/loading cached verdicts, the HF update check, the
 * misplaced/duplicate fixes (which remap the audit + selection state), and the
 * set-source flow. Owns all the audit-result state; the shared selection, the
 * models refresh and the error setter are passed in.
 */
export function useAuditWorkflow({
  auditLocation,
  selected,
  setSelected,
  refreshModels,
  setError,
}: {
  auditLocation: string | null;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  refreshModels: () => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
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
  const [sourceError, setSourceError] = useState<string | null>(null);
  // SHA256 progress of the verification running in the Set source modal.
  const [sourceProgress, setSourceProgress] =
    useState<AuditProgressEvent | null>(null);

  const resetAudit = useCallback(() => {
    setAuditResults(new Map());
    setAuditedPaths(new Set());
    setAuditProgress(new Map());
    setAuditStarted(new Set());
    setUpdateResults(new Map());
    setCheckingUpdates(false);
  }, []);

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
    [auditLocation, setError],
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

  async function loadCachedAudits() {
    if (!auditLocation) return;
    setAuditing(true);
    setError(null);
    let cachedOk = true;
    try {
      seedCachedResults(await fetchCachedResults(auditLocation));
    } catch (e) {
      cachedOk = false;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuditing(false);
    }
    // Cached verdicts are network-free; once they render, check HF for newer
    // versions in the background — but only if the cached load succeeded, so a
    // failing location doesn't stack a second error.
    if (cachedOk) void checkUpdates();
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
            .join('; ')}`,
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

  const cancelSetSource = () => {
    setSourceTarget(null);
    setSourceError(null);
  };

  return {
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
  };
}
