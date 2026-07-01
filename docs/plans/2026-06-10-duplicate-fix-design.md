# Duplicate Fix Action — Design

**Date:** 2026-06-10
**Status:** Approved

## Summary

Add a **Fix** button to `duplicate` audit results. Pressing it resolves the
duplicate group server-side: invalid copies are discarded, the older of two
valid copies is deleted, identical copies are consolidated — and in every case
exactly one verified copy survives, placed at its HuggingFace expected path.
Deletion always takes the copy's `.tjmeta.json` sidecar with it.

Builds on the duplicate detection shipped earlier
(`2026-06-10-duplicate-detection-design.md`).

## Decisions

- **Immediate action, no confirmation modal.** Like the existing Fix for
  misplaced files; the button is labeled `Fix` (no ellipsis — it opens no
  dialog). The algorithm is conservative: when in doubt, nothing is deleted.
- **Survivor always ends at the expected path** (`<repoId>/<repoPath>`),
  whatever case resolved the group, so one click yields a file that would
  audit as `pass`.
- **Server recomputes everything.** The client sends only the audited file
  paths; the group membership, validity verdicts, survivor choice, and move
  target are all derived server-side (the same trust posture as
  `/api/v1/audit/fix`).

## Resolution algorithm (per duplicate group)

A group is every file in the location sharing one basename (from
`duplicateBasenames`). For each group containing a requested file:

1. **Resolve the HF source once** — `resolveSource` per copy until one
   resolves (inference keys on model name + filename, identical for all
   copies; the sidecar-URL fallback is per copy). **No source → skip the
   whole group**, delete nothing, message `unverifiable`.
2. **Stat and hash every copy.** Any hash failure → **skip the whole group**
   (an unhashable copy can't be ruled in or out as the survivor).
3. **Classify each copy:** _valid_ if size+sha256 match the source's latest
   revision, or an earlier revision found by the same history search the
   audit uses (`findHistoricalMatch`); a valid copy pins that revision's
   commit + date. Otherwise _invalid_.
4. **Pick the survivor** among valid copies, by comparator:
   newer pinned commit date first (a latest-revision match therefore beats
   historical matches; an unknown date loses to a known one); tie → the copy
   already at the expected path; tie → lexicographically first path
   (determinism). Identical copies share a pinned revision, so consolidation
   falls out of the same comparator.
   - **No valid copy → skip the whole group**, delete nothing, message
     `no valid copy`.
5. **Delete every other copy** (valid losers and invalid copies) plus its
   sidecar. Per-copy failures are reported as `error` without stopping the
   others.
6. **Place the survivor:** if not already at `expectedRelPath`, move it (and
   its sidecar) there — safe because any previous occupant of that path was
   in the group (same basename) and was just deleted; if its deletion failed,
   the move's existing destination check refuses and the survivor stays put,
   reported as `error`. Finally (re)write the survivor's sidecar from the
   pinned revision and the freshly computed size/sha — written directly, not
   via `refreshMetaSource`, which would trust a possibly stale prior sidecar
   hash over the hash just computed.

## Components

### `lib/fix-duplicates.ts` (new)

```ts
export interface DuplicateFixResult {
  file: string; // original path relative to the storage root
  status: 'kept' | 'deleted' | 'skipped' | 'error';
  to?: string; // kept file's new path, when moved
  message?: string;
}

export async function fixDuplicateGroup(
  basePath: string,
  relPaths: string[], // all same-basename copies, relative to the root
  modelName: string,
  filename: string,
  signal?: AbortSignal,
): Promise<DuplicateFixResult[]>; // one entry per input path
```

Implements the algorithm above. Reuses from `lib/audit.ts`: `resolveSource`,
`localSha256`, `findHistoricalMatch` (newly exported), `expectedRelPath`,
`moveFileWithMeta`, `metaPath`, `writeMeta`, `hfSummary`.

### `app/api/v1/audit/fix-duplicate/route.ts` (new)

`POST {location, files}` → `{results: DuplicateFixResult[]}`. Same
location-to-basePath mapping and `clearHfCache()` as the other audit routes.
Scans the location, computes `duplicateBasenames`, and for each _group_ that
contains at least one requested file, calls `fixDuplicateGroup` once with all
of the group's paths (deduplicated — selecting two copies of one group must
not run it twice). Model name and filename come from the scan entry of the
first requested copy. Results cover **every** copy in the group, requested or
not, so the client can clean up state for unselected twins.

### UI — `components/models/models-table-client.tsx`

In the audit-failure popover, `duplicate` entries get a `Fix` button in the
same position/pattern as the misplaced-Fix button:
`canFixDuplicate = f.status === 'duplicate' && !f.cached && onFixDuplicate != null`,
label `Fixing…` while running. New optional props `onFixDuplicate` /
`fixingDuplicate` threaded through the same component chain as
`onFixMisplaced` / `fixing`.

### UI — `components/home/home-client.tsx`

`onFixDuplicate(paths)` POSTs to the new route and applies results:

- `deleted` → drop the path from `auditResults`, `auditedPaths`, `selected`.
- `kept` → mark `pass` at `to ?? file` (remapping the path like the existing
  moved handling); honest, because the fix just verified that copy's hash.
- `skipped` → leave state as-is.
- any `error` entries → surface via the existing error banner.

Then `refreshModels()`.

## Error handling

Every uncertain case skips destruction: unresolvable source, any hash
failure, no valid copy. Deletion failures are per-copy `error`s that don't
abort the group; the survivor move relies on `moveFileWithMeta`'s
destination-exists refusal as its final guard.

## Testing

Unit tests for `fixDuplicateGroup` (`lib/fix-duplicates.test.ts`) with temp
dirs and stubbed `globalThis.fetch` (the established pattern in
`lib/audit.test.ts`):

- one valid + one invalid copy → invalid deleted with sidecar, survivor kept
  and moved to the expected path
- two distinct valid copies (latest + historical revision) → historical one
  deleted, latest kept
- identical copies, one already at the expected path → that one kept, other
  deleted
- identical copies, none at the expected path → one moved there, rest deleted
- no valid copy → all skipped, files untouched
- unresolvable source → all skipped, files untouched
- survivor sidecar reflects the pinned revision and computed hash

Route and UI changes follow the thin-wrapper pattern and are covered by
typecheck plus the lib tests.
