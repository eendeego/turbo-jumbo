# Update hovercard dates — Implementation Plan

**Goal:** On the Audit column's "Update" hovercard, show both the local
file's date (recorded source-commit date) and the Hugging Face head commit
date for each outdated file.

**Architecture:** Add an optional `localCommitDate` to `UpdateResult`
populated from the sidecar's `sourceCommitDate` in `auditFileUpdate`; render
both dates per file in the `UpdateBadge` hovercard. No route, `decideUpdate`,
or `rowUpdates` changes — the route streams whatever `auditFileUpdate`
returns.

Spec: `docs/specs/2026-06-14-update-hovercard-dates-design.md`

## Task 1: carry `localCommitDate` from the sidecar through `auditFileUpdate`

**Files:**

- Modify: `lib/audit.ts` (the `UpdateResult` interface, and the
  `auditFileUpdate` `update` branch)
- Test: `lib/audit.test.ts` (update the existing "update" test; append one
  new test for the no-local-date case)

Add the field to `UpdateResult`:

```ts
localCommitDate?: string; // ISO 8601 — recorded source-commit date of the local file
```

In `auditFileUpdate`'s `update`-branch return, add the conditional spread
alongside the existing `latestCommitDate` one:

```ts
...(meta.sourceCommitDate ? {localCommitDate: meta.sourceCommitDate} : {}),
```

Tests: the existing "update" test's sidecar already sets a
`sourceCommitDate`, so assert the result now includes `localCommitDate`; add
a new test with a sidecar carrying `sourceCommit` but no `sourceCommitDate`,
asserting the result omits `localCommitDate`.

## Task 2: show both dates in the `UpdateBadge` hovercard

**Files:**

- Modify: `components/models/models-table-client.tsx` (the `UpdateBadge`
  per-file map body)

No unit test (no component-render tests in this repo; the data shape is
covered by Task 1). Verify with typecheck, lint, prettier, and the full
suite.

Replace each file entry's single supporting-text line (name + commit link +
head date) with two lines:

- Line 1: the file basename (unchanged).
- Line 2 (`Text type="supporting"`): `Local: <date>` and
  `Hugging Face: <date>`, with the existing commit permalink (12-char SHA +
  link) attached to the Hugging Face side.

Each date is sliced to `YYYY-MM-DD` (`.slice(0, 10)`) and falls back to
`unknown` when absent, matching the file's existing date-formatting
convention. The commit link keeps its existing guard
(`latestCommitUrl && latestCommit`). The hovercard header and the "Update"
badge itself are unchanged.

## Self-review

- `localCommitDate?: string` defined once on `UpdateResult`, consumed as
  `u.localCommitDate` in the hovercard — no signature drift.
- No change to `decideUpdate`, the audit-updates route, or `rowUpdates`.
- Out of scope: on-disk mtime, `current`/`unknown` rendering, relative date
  formatting.
