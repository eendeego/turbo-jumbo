# Show local and Hugging Face dates on the Update hovercard

**Date:** 2026-06-14
**Status:** Approved (pending spec review)

## Summary

When the Audit column shows the "Update" badge for an outdated file, the
hovercard should display two dates per behind file: the **local file's date**
(the commit date of the Hugging Face revision the local file matches) and the
**Hugging Face date** (the repo's current head commit date). This lets the user
see how far behind their copy is at a glance.

## Definition of "the local file's date"

The sidecar's recorded `sourceCommitDate` — the ISO 8601 commit date of the HF
revision the local file was last verified against. This compares like-for-like
against the HF head commit's date (`latestCommitDate`). It is not the file's
on-disk mtime (which would reflect when it was downloaded, not which version it
is).

## Changes

### `lib/audit.ts`

- Add one optional field to `UpdateResult`:

  ```ts
  localCommitDate?: string; // ISO 8601 — recorded source-commit date of the local file
  ```

- In `auditFileUpdate`, the `update` branch already returns `latestCommit`,
  `latestCommitDate` (head), and `latestCommitUrl`. Add the local date from the
  sidecar, conditionally (a sidecar may carry `sourceCommit` without a
  `sourceCommitDate`):

  ```ts
  ...(meta.sourceCommitDate ? {localCommitDate: meta.sourceCommitDate} : {}),
  ```

  No other branch changes — `current`/`unknown`/null returns are unaffected.
  `decideUpdate`, the `/api/v1/audit/updates` route (which streams whatever
  `auditFileUpdate` returns), and `rowUpdates` need no changes.

### `components/models/models-table-client.tsx` — `UpdateBadge`

Today each file row in the hovercard renders:
`<name> <commit-link (12 char)> ↗ (latestCommitDate sliced to 10)`.

Restructure each file entry to show both dates with clear labels:

- Line 1: the file basename (unchanged).
- Line 2 (muted/supporting): `Local: <localCommitDate→YYYY-MM-DD>` and
  `Hugging Face: <latestCommitDate→YYYY-MM-DD>`, with the existing commit
  permalink (`latestCommitUrl` + 12-char `latestCommit`) attached to the
  Hugging Face side.

Each date renders only when present. If `localCommitDate` is absent, show
`Local: unknown` so the comparison still reads. The HF commit link keeps its
existing guard (`latestCommitUrl && latestCommit`). Dates are sliced to
`YYYY-MM-DD` via `.slice(0, 10)`, matching the existing convention in this file.

The hovercard header ("Newer version on Hugging Face") and the "Update" badge
itself are unchanged.

## Testing

- `lib/audit.test.ts`: update the existing `auditFileUpdate` "update" test —
  its sidecar already sets `sourceCommitDate: '2024-01-01T00:00:00.000Z'`, so
  assert the returned result now includes
  `localCommitDate: '2024-01-01T00:00:00.000Z'`.
- Add an `auditFileUpdate` case: a sidecar with `sourceCommit` but **no**
  `sourceCommitDate`, HF head commit differs → result is `status: 'update'`
  with `localCommitDate` omitted (the rest of the update fields present).
- No component-render tests (the repo has none); the `UpdateBadge` change is
  covered by types and the data-shape tests above.

## Out of scope

- The file's on-disk mtime (explicitly not used).
- Any change to `current`/`unknown` rendering (no marker, no hovercard).
- Localized/relative date formatting — keep the existing `YYYY-MM-DD` slice.
