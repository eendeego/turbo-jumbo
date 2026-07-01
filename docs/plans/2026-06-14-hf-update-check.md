# Check Hugging Face for newer model versions — Implementation Plan

**Goal:** In audit mode, after the cached sidecar verdicts render, automatically
check each model's files against Hugging Face and mark in the Audit column any
file whose recorded `sourceCommit` is behind the repo's current head commit —
network-only, no re-hashing.

**Architecture:** All testable logic lives in `lib/` (a pure `decideUpdate`, a
per-file `auditFileUpdate` that reads the sidecar and asks HF for the head
commit, and a pure `rowUpdates` row aggregator), matching how `auditFile` and
`rowAudit` are structured. A new thin streaming route
(`app/api/v1/audit/updates`) maps `auditFileUpdate` over a location's files and
emits NDJSON, proxying to peers like the other audit routes.
`components/home/home-client.tsx` auto-fires the check after `loadCachedAudits`
and threads results to `components/models/models-table-client.tsx`, which shows
an "Update" badge in the Audit column.

Spec: `docs/plans/2026-06-14-hf-update-check-design.md`

---

### Task 1: `UpdateResult` type and pure `decideUpdate` in `lib/audit.ts`

- `UpdateResult {file, status: 'update'|'current'|'unknown', latestCommit?, latestCommitDate?, latestCommitUrl?}`.
- `decideUpdate(recordedCommit, headCommit)`: `unknown` when either is empty,
  `current` when equal, `update` otherwise. Pure, no I/O.
- Tests: empty-commit unknown, equal current, differing update.

### Task 2: `auditFileUpdate` in `lib/audit.ts`

- Reads the sidecar (`readMeta`); null (not checkable) when there's no
  `originUrl` or no `sourceCommit`. Otherwise `parseHfFileUrl` +
  `canonicalBranch` + `resolveHfFileByPath` for the head entry; `unknown` when
  the head commit can't be resolved, else `decideUpdate` against the recorded
  commit, with `latestCommit`/`latestCommitDate`/`latestCommitUrl` populated
  only on `update`.
- Tests: update (differing commits), current (matching), unknown (HF
  unreachable), null (no sidecar / no recorded commit).

### Task 3: pure `rowUpdates` in `lib/row-audit.ts`

- `rowUpdates(paths, updateResults?)` → the subset of a row's paths whose
  result status is `update`. Empty without a map or with no matches.

### Task 4: `POST /api/v1/audit/updates`

- Same location resolution + peer-proxy pattern as `/api/v1/audit`;
  `clearHfCache()` for fresh head data; `scanModels`, flatten to per-file rel
  paths (shards individually); small bounded worker pool (network-bound, can
  run higher concurrency than the hashing audit) calling `auditFileUpdate` per
  file, streaming NDJSON, skipping files that come back null (not checkable).

### Task 5: wire `checkUpdates` into `components/home/home-client.tsx`

- New `updateResults: Map<string, UpdateResult>` and `checkingUpdates` state,
  cleared by `resetAudit`. `loadCachedAudits` calls `checkUpdates()` after
  seeding cached results — `POST /api/v1/audit/updates`, `readNdjson`, filling
  `updateResults` as lines arrive; failures are non-fatal (cached verdicts
  stay). Pass `updateResults`/`checkingUpdates` into `ModelsTableClient`; a
  subtle "Checking Hugging Face for updates…" note while in flight.

### Task 6: `UpdateBadge` in `components/models/models-table-client.tsx`

- New `updateResults` prop threaded through the component. `UpdateBadge`
  renders a small "Update" token with a hovercard listing each behind file, a
  link to `latestCommitUrl`, and `latestCommitDate`. Rendered next to
  `AuditCell` in the audit column when `rowUpdates(item.paths, updateResults)`
  is non-empty; nothing otherwise.
