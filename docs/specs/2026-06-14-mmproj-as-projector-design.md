# Show mmproj files as a model projector, not a quantization

## Goal

An mmproj (multimodal projector) file like `mmproj-F16.gguf` is currently
mis-classified as a quantization: `extractQuant` reads "F16" from its name, so
the models table renders it as its own quant row and lists "F16" in the model's
quantization summary. Instead, mmproj files should be excluded from
quantizations entirely and listed on the model's hovercard (display-only).

## Background

- `scanModels` (`lib/models.ts`) labels each weight file with a quant via
  `extractQuant`; for `mmproj-F16.gguf` that yields `F16`. The file is grouped
  under its model (by sidecar/cache/flat repo id) the same as any weight.
- `buildModelRows` (`components/models/models-table.tsx`) turns the scan into
  `ModelRow`s: one `QuantInfo` per `f.quant`, and a `quantizations` summary
  string built from the quant labels. An mmproj therefore becomes a quant row
  and appears in the summary. (A downloaded `mmproj-F16.gguf` shows under its
  repo as quant "F16".)
- `augmentWithPeerOnlyQuants` (`components/models/models-table-client.tsx`)
  does the same for files that exist only on a peer.
- The model row (depth 0) already has a hovercard in
  `models-table-client.tsx` showing "Repository" and "Quantizations". This is
  where projectors will be listed.
- The audit feature for a _missing_ mmproj (separate, already shipped) is
  unaffected: it flags a missing projector on the model row and offers
  re-download; a _present_ projector simply needs to stop being a quant.

## Design decisions (settled during brainstorming)

1. **Display-only.** mmproj files are not selectable/deletable/copyable from the
   table once they leave the quant rows; they're managed via the audit
   re-download flow.
2. **Hovercard content:** each projector as `filename · size`.
3. **Sources:** projectors shown in the hovercard are collected from local +
   cold + peer scans (deduped by filename), not local-only.

## Components

### 1. Shared predicate — `lib/model-name.ts`

`lib/model-name.ts` is the documented pure module safe to import from both
server and client. Add:

```ts
/** A GGUF projector file (mmproj-F16.gguf, mmproj-BF16.gguf, …). Pass a
 *  basename. */
export function isMmprojFilename(basename: string): boolean {
  const lower = basename.toLowerCase();
  return lower.startsWith('mmproj') && lower.endsWith('.gguf');
}
```

Refactor `lib/mmproj.ts`'s existing `isMmprojName` to delegate to this (one
definition; `lib/mmproj.ts` is server-only but importing a pure helper from
`model-name.ts` is fine).

### 2. Type — `ModelRow` / `DisplayRow` (`components/models/models-table-client.tsx`)

Add:

```ts
export type ProjectorInfo = {filename: string; size: number};
```

Add `projectors: ProjectorInfo[]` to `ModelRow`. Also add
`projectors: ProjectorInfo[]` to `DisplayRow` (the depth-0 row carries it to the
hovercard; depth-1/2 rows get `[]`).

### 3. Server — `buildModelRows` (`components/models/models-table.tsx`)

Split each scanned model's files into weights vs projectors:

- A file is a projector when `isMmprojFilename(basename)` is true — basename is
  `f.filename` for a `SingleFile` (or `representativeFilename` for the unlikely
  split case).
- Projector files are **excluded** from all per-quant processing (the
  `quantMap`, `localPathsMap`, `localDisplayNames`, cold index, and
  `coldQuantSizes`), so they never become a `QuantInfo` and never collide with a
  real same-label weight (today a real `F16` weight and `mmproj-F16` both key on
  "F16" and clobber each other — this removes that latent bug).
- Collect projector files into a per-model list `{filename, size}` (size =
  `f.size`, or `f.totalSize` if split), from **both** the local and cold scans,
  deduped by filename per model.
- Attach `projectors` to each returned `ModelRow`. The `quantizations` string is
  unchanged in code — it now naturally omits mmproj because they aren't quants.

The cleanest structure is a small helper that, given a `Model[]`, returns the
models with projector files removed plus a `Map<modelName, ProjectorInfo[]>`,
applied to the (normalized) local and cold scans before the existing logic runs.

### 4. Client — `augmentWithPeerOnlyQuants` (`components/models/models-table-client.tsx`)

- Skip files where `isMmprojFilename(f.filename ?? representativeFilename)` when
  gathering peer-only quants (so a peer's projector never becomes a quant).
- Merge peer projectors into each model's `projectors` (deduped by filename
  against what's already there), so a projector that exists only on a peer still
  appears in the hovercard.

### 5. ModelRow / DisplayRow construction sites

Set the new field everywhere these are built (TypeScript will flag each):

- `components/models/models-table.tsx` `buildModelRows` return: the collected
  `projectors`.
- `components/models/models-table-client.tsx`:
  - peer-only synthetic `ModelRow` in `augmentWithPeerOnlyQuants`: the model's
    merged peer projectors (or `[]`).
  - `effectiveModels` rebuild: carry `projectors` through from the source `m`.
  - depth-0 `DisplayRow`: `projectors: m.projectors`.
  - depth-1 and depth-2 `DisplayRow`: `projectors: []`.

### 6. Hovercard — depth-0 model card in `models-table-client.tsx`

After the "Quantizations" block, when `row.projectors.length > 0`, render a
section:

```tsx
<Text type="supporting">
  {row.projectors.length > 1 ? 'Projectors' : 'Projector'}
</Text>
<Text type="body">
  {row.projectors
    .map((p) => `${p.filename} · ${formatSize(p.size)}`)
    .join(', ')}
</Text>
```

`formatSize` already exists in this file.

## Data flow

```
scanModels (unchanged; mmproj still labeled "F16")
  → buildModelRows: split weights vs projectors
       weights → QuantInfo / quantizations (mmproj excluded)
       projectors → ModelRow.projectors (local + cold, deduped)
  → augmentWithPeerOnlyQuants: skip mmproj quants; merge peer projectors
  → DisplayRow (depth 0 carries projectors)
  → model hovercard lists "filename · size"
```

## Error / edge handling

- A model whose only file is an mmproj (e.g. an orphan projector) yields a
  `ModelRow` with no quants and a populated `projectors`; it still renders (the
  table tolerates zero-quant rows — `minSize/maxSize` fall back to 0). Note: an
  mmproj stored flat with **no sidecar** is named `mmproj` by `scanModels`
  (filename-derived) and forms its own `mmproj` model rather than grouping under
  the repo; this is pre-existing scan behavior and out of scope — projectors are
  associated with whatever model the scan grouped them under.
- Deduping is by filename within a model, so the same projector present in
  local + cold + peer is listed once.

## Testing

- `lib/model-name.test.ts`: `isMmprojFilename` — true for `mmproj-F16.gguf` /
  mixed case; false for `mmproj` (no suffix), `mmproj-readme.txt`, and a normal
  weight name.
- `components/models/models-table.test.ts` (pure — it takes `Model[]` scans):
  an mmproj file is excluded from `quants` and from the `quantizations` string
  and appears in `projectors`; a real `F16` weight plus `mmproj-F16` in the
  same model both survive (weight as the `F16` quant, mmproj as a projector —
  no collision); a model with only weights has empty `projectors`.
- Hovercard rendering verified manually: a model with a downloaded projector
  shows "Projector: mmproj-F16.gguf · <size>" and no "F16" quant row / summary
  entry.

## Out of scope

- Per-file actions (select/delete/copy) for mmproj from the table — display-only
  by decision.
- Re-associating an orphan flat-no-sidecar `mmproj` model with its repo.
- Changing `scanModels` quant labeling or the audit features.
