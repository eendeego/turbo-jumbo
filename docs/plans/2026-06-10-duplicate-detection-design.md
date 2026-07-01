# Audit Duplicate Detection — Design

**Date:** 2026-06-10
**Status:** Approved

## Summary

When auditing a storage location, detect **duplicate files**: two or more files
in the same location that share a **filename** (basename), regardless of which
directory each sits in. Example:

- `/mnt/models/gemma-4-26B-A4B-it-UD-IQ2_M.gguf`
- `/mnt/models/unsloth/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-IQ2_M.gguf`

Each colliding file gets a new audit verdict, **`duplicate`**, whose message
names the other copy/copies. Without this, the stray copy reports `misplaced`
and its Fix move fails with "destination already exists".

## Decisions

- **Criterion: same basename, exact match.** No hashing, no HF resolution
  needed. Renamed copies and same-name-different-bytes nuances are out of
  scope.
- **Reporting: a new `duplicate` audit status** on _every_ file that shares
  its basename with another, with a message listing the other copies' paths.
- **Precedence: duplicate wins.** A colliding file reports `duplicate` even if
  it is also corrupt or misplaced; content checks are skipped entirely
  (fast-fail, like the existing missing-shards path).
- **Scope: within one storage location.** A local file that also exists in
  cold storage is a backup, not a duplicate (`notInColdStorage` already covers
  that relationship).
- **No new repair action.** The stray copy is removed via the existing delete
  flow; per project convention, the tool surfaces it rather than deleting.

## Components

### `lib/models.ts` — `duplicateBasenames(models: Model[]): Map<string, string[]>`

Pure helper over scan output: maps basename → all relative paths bearing it,
keeping only entries with 2+ paths. Split groups contribute each shard's own
filename. Lives in `models.ts` because it is scan-shaped, not audit-shaped.

### `lib/audit.ts` — `AuditStatus`

Gains `'duplicate'`.

### Fresh audit route (`app/api/v1/audit/route.ts`)

After `scanModels()`, compute `duplicateBasenames` over **all** files in the
location (the twin need not be selected). For each selected file whose
basename collides, emit
`{file, status: 'duplicate', message: 'duplicate of <other path(s)>'}`
immediately — no `auditFile` call, no sidecar write (same as the
missing-shards fast-fail). The duplicate check takes precedence over the
missing-shards fast-fail for shards whose names collide.

### Cached audit route (`app/api/v1/audit/cached/route.ts`)

Applies the same overlay: colliding files report
`{status: 'duplicate', cached: true, message: …}` instead of (and regardless
of) any sidecar-derived verdict, so the pre-filled column agrees with a fresh
run. Emitted even when no sidecar exists, since the verdict is scan-derived.

### UI (`components/models/models-table-client.tsx`)

- `AUDIT_BADGE`: `duplicate: {label: 'Duplicate', variant: 'warning'}`.
- `AUDIT_SEVERITY`: slots between `incomplete` and `misplaced`
  (error 6 > checksum-mismatch 5 > incomplete 4 > **duplicate 3** >
  misplaced 2 > unverifiable 1 > pass 0).
- The failure panel lists duplicates like other non-pass results; the message
  names the other copies. No Fix button, no new buttons.

## Error handling

- Duplicate detection is pure path comparison over the scan; it introduces no
  new I/O or network failure modes.
- A file that vanishes between scan and audit still short-circuits as
  `duplicate` (verdict is scan-derived); the next run re-scans.

## Testing

Unit tests for `duplicateBasenames` in `lib/models.test.ts`:

- root-level file + nested same-name file → both paths returned under the name
- three copies → all three listed
- unique filenames → empty map
- split shards: colliding shard filenames across two directories are detected;
  a single split group alone does not collide with itself
- collisions computed over all files, independent of any selection

Route-level behavior (status emission, cached overlay) follows the existing
pattern of thin handlers over tested lib helpers.
