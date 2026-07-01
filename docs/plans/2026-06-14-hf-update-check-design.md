# Check Hugging Face for newer model versions

**Date:** 2026-06-14
**Status:** Approved (pending spec review)

## Summary

In audit mode, once the cached/sidecar verdicts have rendered, automatically
check every model's files against Hugging Face to see whether a more recent
version exists upstream. The check is **network-only** — it never re-hashes the
local files. It compares Hugging Face's current last-modifying commit for each
file against the commit the file's sidecar last recorded, and surfaces an
"update available" marker in the Audit column for files that are behind.

This is the cheap counterpart to a full audit: a full audit re-resolves the
branch head _and_ re-hashes multi-GB files; this check only asks Hugging Face
for the head commit and compares it to recorded metadata.

## Definition of "a more recent version"

For a single file, **commit-based**: Hugging Face's current branch-head
last-modifying commit for that file differs from the `sourceCommit` recorded in
the file's `.tjmeta.json` sidecar.

- `update` — head commit is known, recorded commit is known, and they differ.
- `current` — head commit equals the recorded commit.
- `unknown` — either commit is missing (a legacy sidecar without `sourceCommit`,
  an unverifiable file with no source, or Hugging Face couldn't be reached).

**Known limitation (accepted):** because the comparison is by commit, a repo
that re-commits a file without changing its bytes reads as `update` even though
the on-disk copy is byte-identical to the new commit. This is inherent to a
commit comparison and was chosen deliberately over a sha-based comparison.

## Trigger

Automatic. When the user enters audit mode and runs the cached render (clicking
Audit with nothing selected → `loadCachedAudits`), the update check fires
immediately afterward in the background. Rows gain their update marker as
results stream in. A subtle "Checking for updates…" indicator is shown while
the run is in flight.

## Scope

- Runs for the same locations audit supports: the local peer, cold storage, and
  remote peers (proxied to the peer, which reads its own sidecars).
- Only files whose sidecar carries a resolved source (`originUrl`) **and** a
  recorded `sourceCommit` are checkable. Everything else is skipped — no marker.

## Backend

### `lib/audit.ts`

- New `UpdateResult` type:

  ```ts
  interface UpdateResult {
    file: string; // path relative to the storage root
    status: 'update' | 'current' | 'unknown';
    latestCommit?: string; // head commit SHA, when known
    latestCommitDate?: string; // ISO 8601, when known
    latestCommitUrl?: string; // blob page pinned to the head commit
  }
  ```

- New pure function `decideUpdate(recordedCommit: string, headCommit: string):
UpdateResult['status']` — returns `unknown` when either argument is empty,
  `current` when they are equal, `update` otherwise. Unit-testable with no I/O.

### `app/api/v1/audit/updates/route.ts` (new)

`POST { location }`, streaming NDJSON `UpdateResult` lines (the same streaming
pattern as `app/api/v1/audit/route.ts`).

1. Resolve the location with `resolveAuditLocation`; reject the aggregate view.
   For a remote peer, proxy with `proxyAuditRequest` to the peer's
   `/api/v1/audit/updates`.
2. Call `clearHfCache()` so head data reflects current Hugging Face state rather
   than a tree cached by an earlier audit in the same process.
3. `scanModels(basePath)`; for each physical file (each shard of a split):
   - Read the sidecar (`readMeta`). Skip if absent, or if it has no `originUrl`
     or no `sourceCommit`.
   - Derive `repoId`/`branch`/`repoPath` from `originUrl` via `parseHfFileUrl`,
     canonicalizing the branch with `canonicalBranch` (a commit-pinned source
     resolves against `main`, matching `resolveSource`).
   - `resolveHfFileByPath(repoId, canonicalBranch(branch), repoPath)` for the
     head entry. On null (gone/unreachable) or empty head commit → emit
     `unknown`.
   - Otherwise compare with `decideUpdate(meta.sourceCommit, head.commit)` and
     emit an `UpdateResult`, including `latestCommit`, `latestCommitDate`, and a
     `latestCommitUrl` blob permalink when `status === 'update'`.
4. A bounded worker pool (small, gentle on Hugging Face) runs the per-file
   checks; the per-repo tree cache in `hf-infer.ts` means quants sharing a repo
   cost a single tree fetch. Aborts when the client disconnects.

Files that are skipped emit nothing — the absence of a result is "not
checkable," which the UI renders as no marker.

## Frontend

### `components/home/home-client.tsx`

- New state: `updateResults: Map<string, UpdateResult>` and
  `checkingUpdates: boolean`. Both cleared by `resetAudit` alongside the other
  audit state.
- After `loadCachedAudits()` resolves, call `checkUpdates()`:
  - `POST /api/v1/audit/updates { location: auditLocation }`.
  - Stream with `readNdjson<UpdateResult>`, setting `updateResults[r.file] = r`
    as each line arrives.
  - Toggle `checkingUpdates` around the run; failure sets a non-fatal error and
    leaves cached verdicts intact.
- Pass `updateResults` (and optionally `checkingUpdates`) into
  `ModelsTableClient`.

### `components/models/models-table-client.tsx`

- The Audit column gains an update marker. For a row, aggregate over
  `row.paths`: if any path has an `updateResults` entry with `status === 'update'`,
  render an `↑ Update` badge next to the cached verdict token.
- The badge carries a hovercard listing each updated file in the row with its
  newer commit (a link to `latestCommitUrl`) and `latestCommitDate`.
- `current` and `unknown` render no marker. The marker is additive to the
  existing audit verdict, not a replacement.
- A subtle "Checking for updates…" indicator (driven by `checkingUpdates`) sits
  near the audit controls while the run is in flight.

## Data flow

```
Enter audit mode → click Audit with nothing selected
  → loadCachedAudits()  (renders cached sidecar verdicts)
  → checkUpdates()       (auto, background)
       POST /api/v1/audit/updates { location }
         server: clearHfCache(); scanModels(basePath)
         per file with a sourced+committed sidecar (streamed):
           parseHfFileUrl(originUrl) → resolveHfFileByPath(head)
           decideUpdate(sourceCommit, head.commit)
           emit { file, status, latestCommit, latestCommitUrl, … }
  → updateResults filled; rows show ↑ Update as lines arrive
```

## Error handling

- Per-file Hugging Face failure → `unknown` for that file; the run and other
  files continue, and the file's audit verdict is unaffected.
- Whole-run failure (endpoint unreachable) → non-fatal error message; the
  cached verdicts already on screen remain.
- A sidecar predating `sourceCommit`, or an unverifiable file, is not checkable
  and shows no marker.

## Testing

- `decideUpdate`: `unknown` when either commit is empty, `current` on equal
  commits, `update` on differing commits.
- `app/api/v1/audit/updates/route.ts`: location → base-path resolution; rejects
  the aggregate view; proxies remote peers; NDJSON shape; skips sidecars with no
  source or no `sourceCommit`; emits `update`/`current`/`unknown` correctly
  against mocked Hugging Face responses and temp-dir sidecars; canonicalizes a
  commit-pinned `originUrl` to `main` before resolving the head.
- `components/models/models-table-client.tsx`: the `↑ Update` badge appears when
  a row path has an `update` result and not otherwise; hovercard lists the newer
  commit link and date.

## Risks

- **Commit-based false positives** — no-op recommits read as updates (accepted
  above).
- **Hugging Face rate limits** — mitigated by the per-run tree cache and a small
  worker pool; the check is head-commit-only (no per-revision history walk).
- **Surprise network traffic** — the check is automatic on every audit-mode
  cached render; bounded by one tree fetch per distinct repo at the location.
