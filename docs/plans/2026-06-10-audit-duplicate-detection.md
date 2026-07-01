# Audit Duplicate Detection Implementation Plan

**Goal:** Audits flag files that share a basename with another file in the same
storage location as `duplicate`, naming the other copies.

**Architecture:** A pure scan-level helper (`duplicateBasenames`) finds
basename collisions over `scanModels()` output. Both audit routes (fresh and
cached) consult it first and fast-fail colliding files with a new `duplicate`
status — no HF resolution, no hashing, no sidecar write — mirroring the
existing missing-shards fast-fail. The UI gains a badge variant and severity
slot for the new status.

**Tech Stack:** Next.js 16 App Router, TypeScript (strict), `bun test`,
Jujutsu (`jj`) for VCS.

**Spec:** `docs/plans/2026-06-10-duplicate-detection-design.md`

---

### Task 1: `duplicateBasenames` helper

- Add to `lib/models.ts` (after `scanModels`):
  `duplicateBasenames(models: Model[]): Map<string, string[]>` — maps
  basename → every relative path bearing it, keeping only names with 2+ paths.
  Split groups contribute each shard's own filename via `path.basename`.
- Tests in `lib/models.test.ts`: root + nested copy of the same file; three
  copies of one file; all-unique filenames → empty map; colliding split
  shards across two directories detected, a lone split group does not
  self-collide.

### Task 2: `duplicate` status, `duplicateResult` helper, UI token

- Extend `AuditStatus` in `lib/audit.ts` with `'duplicate'`.
- Add `duplicateResult(relPath, allPaths, cached = false): AuditResult` —
  fast-fail verdict naming the _other_ copies (`allPaths` minus `relPath`),
  joined with `, `. `cached` is passed through only when true.
- In `components/models/models-table-client.tsx`:
  - `AUDIT_BADGE`: add `duplicate: {label: 'Duplicate', variant: 'warning'}`.
  - `AUDIT_SEVERITY`: insert `duplicate` between `incomplete` and `misplaced`
    (error 6 > checksum-mismatch 5 > incomplete 4 > **duplicate 3** >
    misplaced 2 > unverifiable 1 > pass 0).
- No other UI change: `expectedDetail` already returns null for unknown
  statuses, and the Fix / Set-source / Redownload buttons are keyed to other
  statuses so `duplicate` gets none of them.
- Test in `lib/audit.test.ts`: `duplicateResult` names the other copies (not
  the file itself), and passes through `cached: true` when requested.

### Task 3: Fresh audit route fast-fails duplicates

- In `app/api/v1/audit/route.ts`, after `scanModels(root)`, compute
  `duplicateBasenames(models)` over **all** files in the location — the twin
  need not be selected.
- In the job-collection loop, check the duplicate map **before** the
  missing-shards fast-fail (duplication wins over that check too) and before
  building an `auditFile` job: a colliding selected file (or shard) pushes an
  immediate resolved job with `duplicateResult(...)`, no `auditFile` call.

### Task 4: Cached audit route reports duplicates

- In `app/api/v1/audit/cached/route.ts`, compute `duplicateBasenames(models)`
  once per request and check it before the sidecar read in `fromSidecar`: a
  colliding path emits `duplicateResult(relPath, dupPaths, true)` and returns,
  skipping `readMeta` — the verdict is scan-derived, so it's emitted even when
  no sidecar exists.

### Task 5: Final verification

- `bun test && bun typecheck && bun lint && bun format:check` all green.
