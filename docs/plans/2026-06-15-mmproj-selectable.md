# mmproj-Selectable Implementation Plan

**Goal:** Make mmproj projector rows selectable with correct Cold Storage /
Peers columns by folding them back into `quants` as `isProjector`-flagged
entries, and qualify mmproj by model in the cross-host join key.

**Architecture:** `fileJoinKey` qualifies mmproj by model (fixing cold/peer
false-positives). `buildModelRows` keeps mmproj as `QuantInfo` flagged
`isProjector` (keyed by filename to avoid the F16 collision), with
weights-only model rollups. The table renders projector quants as distinct
rows that are selectable and location-tracked; the separate
`projectors`/`ProjectorInfo` machinery is removed.

Spec: `docs/specs/2026-06-15-mmproj-selectable-design.md`

## File structure

- `lib/peer-paths.ts` + `lib/peer-paths.test.ts` — `fileJoinKey` qualifies
  mmproj.
- `components/models/models-table-client.tsx` — `QuantInfo.isProjector`;
  remove `ProjectorInfo`/`ModelRow.projectors`; augment, peerQuantSizes,
  rows, and Peers/Cold/Audit cells.
- `components/models/models-table.tsx` + `.test.ts` — `buildModelRows` folds
  projectors into quants.

`projectors`/`ProjectorInfo` stay (unused) until the final task removes
them, so earlier tasks compile.

## Task 1: Qualify mmproj in `fileJoinKey`

```ts
export function fileJoinKey(modelName: string, basename: string): string {
  return GENERIC_WEIGHT_RE.test(basename) || isMmprojFilename(basename)
    ? `${modelName} ${basename}`
    : basename;
}
```

Tests: an mmproj basename is qualified by model name and two different
models get distinct keys; a specific GGUF weight name stays unqualified.

## Task 2: Fold projectors into quants in `buildModelRows`

Add `isProjector?: boolean` to `QuantInfo`.

In `buildModelRows`, drop the strip-into-`ProjectorInfo` step and instead key
every per-file map (`localPathsMap`, `localDisplayNames`, `coldQuantSizes`,
the `quantMap`) by a `fileLabel(f)` helper:

```ts
const fileLabel = (f: ModelFile): string => {
  const base = f.isSplit ? f.representativeFilename : f.filename;
  return isMmprojFilename(base) ? base : f.quant;
};
```

The built `QuantInfo` sets `label: fileLabel(f)` and
`isProjector: isMmprojFilename(base)`; everything else (cold-join via
`coldMatch`/`fileJoinKey`, `paths`, `coldPaths`, sizes) stays as-is, so a
projector now carries full location data.

Sort projectors after weights, then by quant bits. Compute `quantizations`,
`minSize`, `maxSize`, `allInColdStorage`, `noneInColdStorage` from the
weight quants only; drop `projectors` from the returned row.

Tests: an mmproj becomes an `isProjector` quant with `label` = filename,
excluded from `quantizations`/`minSize`/`maxSize`; a real `F16` weight
alongside `mmproj-F16` stays distinct (no collision); a projector's cold
presence requires the _same_ model, not just a matching filename; a
weights-only model has no projector quant.

## Task 3: Peer-only projector quants — `augmentWithPeerOnlyQuants` + `peerQuantSizes`

Remove the `peerProjectors` map and the mmproj skip; key every peer file (for
both `existingKeys` and the synthesized peer-only quant) by the same
filename-for-mmproj-else-quant logic, setting `isProjector` on the
synthesized `QuantInfo`. A peer-only projector becomes a normal peer-only
(projector) quant. Apply the same projectors-last sort and weights-only
rollups in the augment rebuild as in Task 2.

Key `peerQuantSizes` by filename for mmproj instead of skipping it, so a
projector's size-mismatch breakdown across peers works like a quant's.

## Task 4: Render projector quants as selectable rows; remove old plumbing

- Apply the projectors-last sort in the row-building `useMemo`'s quant sort;
  set `isProjector: q.isProjector` on each depth-1 row; delete the separate
  projector-row-push block (projectors are quants now, already emitted by
  the quant loop).
- `PeersCell`: drop the `isProjector` early return.
- `ColdStorageCell`: drop the `isProjector` early return.
- Audit column: drop the `isProjector` early return.
- Select column: unchanged (already renders whenever `paths.length > 0`).
- Delete `ProjectorInfo` and `ModelRow.projectors`; `DisplayRow.isProjector`
  stays.

Manual verification: expand a model with a downloaded projector — its row
shows a checkbox, Size, and correct Cold Storage/Peers cells; selecting it
and using Copy/Delete operates on the projector file; a peer with a
_different_ model's identically-named projector doesn't light the Peers
cell; the model's Quantizations summary and Size range stay weights-only;
the projector still renders with its distinct "projector" badge beneath the
quant rows.

## Self-review

- `isProjector?: boolean` named identically on `QuantInfo`, `DisplayRow`,
  and the augment's `PeerOnly` type.
- `fileLabel`/filename-keying and the projectors-last comparator are
  identical across `buildModelRows`, the augment rebuild, and the row
  builder.
- `ProjectorInfo`/`ModelRow.projectors` remain unused through the middle
  tasks and are removed only in the final task, so every task compiles.
