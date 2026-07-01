# Make mmproj projectors selectable and location-tracked

## Goal

mmproj projector rows are currently display-only: they show a filename and size
but can't be selected (delete/copy) and show no cold-storage or peer presence.
Make them first-class like quant rows — selectable, with correct Cold Storage
and Peers columns — while keeping their distinct "projector" row styling and
their exclusion from the model's Quantizations summary.

## Background

- `buildModelRows` (`components/models/models-table.tsx`) currently **strips**
  mmproj files out of quant assembly into a separate `ModelRow.projectors:
ProjectorInfo[]` (`{filename, size}` only — no paths, no cold/peer data). The
  table renders those as distinct depth-1 rows flagged `DisplayRow.isProjector`,
  and `PeersCell`/`ColdStorageCell`/audit/select cells skip them.
- Selection, copy, delete, cold-join, peer-presence, and per-quant size all
  operate over `model.quants` (a `QuantInfo` carries `paths`, `coldPaths`,
  `inColdStorage`, `coldComplete`, etc.). Because projectors aren't quants, they
  have none of this.
- **Cross-host join hazard:** `fileJoinKey` (`lib/peer-paths.ts`) qualifies only
  _generic safetensors/bin_ names (`GENERIC_WEIGHT_RE`) by model name; a
  `.gguf` such as `mmproj-F16.gguf` joins on its **basename alone**. Every vision
  model ships an `mmproj-F16.gguf`, so cold/peer presence joined on the bare
  basename would match a _different_ model's projector — a false positive.

## Design decisions (settled during brainstorming)

1. **Fold projectors back into `quants`** as `isProjector`-flagged `QuantInfo`,
   rather than enriching the separate `ProjectorInfo`. This gives selection,
   copy, delete, cold-join, and peer presence for free; the separate
   `projectors`/`ProjectorInfo`/`stripProjectors`/`peerProjectors` machinery is
   removed.
2. **Key projector quants by filename, not quant label**, so a real `F16` weight
   and `mmproj-F16.gguf` don't collide (both extract quant "F16").
3. **`fileJoinKey` qualifies mmproj by model name** (like generic names) —
   required for correct cold and peer joins.
4. **Weights-only model rollups:** the model row's Size range and
   `allInColdStorage`/`noneInColdStorage` are computed from weight quants only;
   the projector row shows its own size and cold/peer state.
5. Projectors keep their distinct row styling and stay out of the Quantizations
   summary. They become selectable and (consistently) auditable like other
   files.

## Components

### 1. `fileJoinKey` qualifies mmproj — `lib/peer-paths.ts`

Import `isMmprojFilename` from `@/lib/model-name` and qualify mmproj by model:

```ts
export function fileJoinKey(modelName: string, basename: string): string {
  return GENERIC_WEIGHT_RE.test(basename) || isMmprojFilename(basename)
    ? `${modelName} ${basename}`
    : basename;
}
```

This flows through every consumer (`peerFileKeys`, `withPeerPaths`, and
`buildModelRows`'s cold index) so projector cold/peer joins are model-scoped.

### 2. Types — `components/models/models-table-client.tsx`

- Add `isProjector?: boolean` to `QuantInfo`.
- Remove `ProjectorInfo` and `ModelRow.projectors`.
- Keep `DisplayRow.isProjector?: boolean` (now sourced from the quant).

### 3. `buildModelRows` — `components/models/models-table.tsx`

- Remove `stripProjectors` / `projectorsByModel` / `addProjector`; use the full
  normalized scans directly.
- A per-file key helper: for a projector, the key/identity is its filename;
  otherwise the quant label.

  ```ts
  const fileLabel = (f: ModelFile): string => {
    const base = f.isSplit ? f.representativeFilename : f.filename;
    return isMmprojFilename(base) ? base : f.quant;
  };
  ```

  Use `fileLabel(f)` everywhere `f.quant` is currently used as the per-quant key:
  `localPathsMap`, `localDisplayNames`, `coldQuantSizes`, the `quantMap` key, and
  the `quantKey`.

- The built `QuantInfo` sets `label: fileLabel(f)` and
  `isProjector: isMmprojFilename(base)`. Everything else (cold-join via
  `coldMatch`/`fileJoinKey`, `paths`, `coldPaths`, sizes) is unchanged — so a
  projector now carries full location data (cold mmproj are indexed because the
  scans are no longer stripped and `fileJoinKey` qualifies them).
- Sort projectors after weights, then by quant bits. Compute `quantizations`,
  `minSize`, `maxSize`, `allInColdStorage`, `noneInColdStorage` from the
  weight quants only (not the projector quants). Drop the `projectors` field
  from the returned row.

### 4. Peer-only quants — `augmentWithPeerOnlyQuants`

- Remove the `peerProjectors` map and the early-`continue` mmproj skip.
- Key each peer file by the filename-for-mmproj-else-quant logic for both
  `existingKeys` and the synthesized peer-only `QuantInfo`, and set
  `isProjector` on it. A peer-only projector then becomes a normal peer-only
  (projector) quant — no separate path.
- Keep the plain early return (no peer projector map anymore).

### 5. Per-quant peer sizes — `peerQuantSizes`

Key by filename for mmproj instead of skipping them, so a projector's
size-mismatch breakdown across peers works like a quant's (replaces the
current mmproj `continue`).

### 6. Rows + cells

- **Row-building `useMemo`**: apply the same projectors-last sort as
  `buildModelRows` so projector rows render beneath weight rows. Building each
  depth-1 row from a quant, set `isProjector: q.isProjector`. Remove the
  separate projector-row-push block (projectors are quants now).
- **`NameCell`**: keep the existing projector branch (neutral "projector"
  badge + `row.label`, which is now the filename).
- **`PeersCell`**: remove the `isProjector` early return — projector rows now
  show peer badges (via their `paths` + the qualified `peerKeys`).
- **`ColdStorageCell`**: remove the `isProjector` early return — projector
  rows now show cold status from their `inColdStorage`/`coldComplete`.
- **Select column**: unchanged — it already renders a checkbox whenever
  `paths.length > 0`, which projector rows now have.
- **Audit column**: remove the `isProjector` early return so a selected
  projector audits like any file. The missing-mmproj detection (synthetic
  verdict on the model row) is unaffected.

## Data flow

```
scanModels (mmproj included, labeled "F16")
  → buildModelRows: mmproj kept as QuantInfo{isProjector, label=filename,
       full cold-join via fileJoinKey(model-qualified)}; weights-only rollups
  → augmentWithPeerOnlyQuants: peer-only projectors become projector quants
  → rows: projector quants sort last, render as projector rows
       with paths → selectable; PeersCell/ColdStorageCell read their data
  → fileJoinKey(model-qualified) ⇒ correct cold & peer presence per model
```

## Error / edge handling

- A projector present on multiple hosts joins per model (qualified key), so
  Model A's projector never matches Model B's identically-named one.
- A model with only a projector and no weights yields a row with empty
  weight rollups (`minSize/maxSize = 0`, `quantizations = ''`) and a single
  projector quant row; it still renders.
- Split mmproj (unusual) is keyed by its representative filename; handled by
  the same `fileLabel` path.

## Testing

- `lib/peer-paths.test.ts`: `fileJoinKey` qualifies an mmproj basename by
  model name and leaves a specific GGUF weight name unqualified;
  `peerFileKeys` yields model-qualified keys for mmproj.
- `components/models/models-table.test.ts`: an mmproj is a quant with
  `isProjector: true`, `label` = filename, `paths` populated, and is
  **excluded** from `quantizations`, `minSize`/`maxSize`, and
  `allInColdStorage`; a real `F16` weight alongside `mmproj-F16` keeps a
  distinct `F16` weight quant (no collision); a projector's cold presence is
  detected when a same-named cold copy exists under the same model (and NOT
  when only a _different_ model has one).
- Manual: expand a model with a downloaded projector — the projector row has
  a checkbox, a Size, and correct Cold Storage / Peers cells; selecting it
  and using Copy/Delete operates on the projector file; the Quantizations
  summary and model Size range are unchanged (weights only).

## Out of scope

- Changing `scanModels` quant labeling.
- The missing-mmproj audit verdict / re-download flow (unchanged).
- Model-level rollups counting projectors (explicitly weights-only).
