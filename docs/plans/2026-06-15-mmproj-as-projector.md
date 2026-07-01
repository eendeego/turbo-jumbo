# mmproj-as-Projector Implementation Plan

**Goal:** Stop treating mmproj (projector) files as quantizations; exclude
them from the table's quant rows/summary and list them (filename · size) on
the model hovercard.

**Architecture:** A shared pure predicate `isMmprojFilename` identifies
projectors. `buildModelRows` (server) splits them out of quant assembly into
a new optional `ModelRow.projectors`; `augmentWithPeerOnlyQuants` (client)
does the same for peer files and merges peer projectors. The depth-0 model
hovercard renders the projector list. mmproj files are display-only (not
selectable).

Spec: `docs/specs/2026-06-14-mmproj-as-projector-design.md`

## File structure

- `lib/model-name.ts` (modify) — add client+server-safe `isMmprojFilename`.
- `lib/model-name.test.ts` (modify) — tests for it.
- `lib/mmproj.ts` (modify) — delegate `isMmprojName` to `isMmprojFilename`.
- `components/models/models-table-client.tsx` (modify) — add `ProjectorInfo`
  - optional `projectors` to `ModelRow`/`DisplayRow`; exclude mmproj + merge
    peer projectors in `augmentWithPeerOnlyQuants`; carry projectors onto the
    depth-0 row; render the hovercard section.
- `components/models/models-table.tsx` (modify) — split projectors out of
  quant assembly in `buildModelRows`; populate `projectors`.
- `components/models/models-table.test.ts` (create) — `buildModelRows`
  projector behavior.

`projectors` is **optional** (`projectors?: ProjectorInfo[]`) on both row
types, so each task compiles independently; consumers treat `undefined` as
empty.

## Task 1: Shared `isMmprojFilename` predicate

Add to `lib/model-name.ts`:

```ts
export function isMmprojFilename(basename: string): boolean {
  const lower = basename.toLowerCase();
  return lower.startsWith('mmproj') && lower.endsWith('.gguf');
}
```

In `lib/mmproj.ts`, delegate the existing `isMmprojName` to it (keeps the
export for existing callers/tests, but one definition).

Tests: true for `mmproj-F16.gguf` / mixed case; false for `mmproj` (no
suffix), `mmproj-readme.txt`, and a normal weight name.

## Task 2: Split projectors out of quants in `buildModelRows`

Add `export type ProjectorInfo = {filename: string; size: number};` and an
optional `projectors?: ProjectorInfo[]` field on `ModelRow`
(`components/models/models-table-client.tsx`).

In `buildModelRows` (`components/models/models-table.tsx`), before quant
assembly, strip mmproj files out of both the local and cold (normalized)
scans into a `Map<modelName, ProjectorInfo[]>` (deduped by filename, size
from `f.size`/`f.totalSize`), then run the existing quant-building logic on
the stripped models. Attach `projectors: projectorsByModel.get(name) ?? []`
to each returned row.

Tests (`components/models/models-table.test.ts`, new): an mmproj is excluded
from `quants`/`quantizations` and appears in `projectors`; a real `F16`
weight plus `mmproj-F16` in the same model both survive without colliding; a
weights-only model has empty `projectors`.

## Task 3: Exclude mmproj + merge peer projectors in `augmentWithPeerOnlyQuants`

In `augmentWithPeerOnlyQuants`, skip a peer file when
`isMmprojFilename(basename)` — instead of adding it to `peerOnly`, collect it
into a `peerProjectors` map (deduped by filename). Change the early-return
guard to also check `peerProjectors.size === 0`. After building `byModel`,
merge each model's peer projectors into its `projectors` list (deduped
against what's already there); a peer-only model with just a projector and
no quants has nothing to merge into and is skipped.

## Task 4: Carry projectors to the depth-0 row and render the hovercard

Add `projectors?: ProjectorInfo[]` to `DisplayRow`; populate it on the
depth-0 row from `m.projectors` (depth-1/2 rows leave it unset).

In the depth-0 model hovercard, after the "Quantizations" line, when
`row.projectors` is non-empty, render:

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

Manual verification: a model with a downloaded projector no longer shows a
bogus quant row for it, its quantization summary omits the projector's
label, and hovering the model name lists "Projector: <filename> · <size>".

## Self-review

- `ProjectorInfo {filename, size}` and the `projectors?` field are named and
  shaped identically everywhere they're defined/consumed.
- `buildModelRows`/`augmentWithPeerOnlyQuants` signatures are unchanged —
  only internals and the new optional return field.
- Optional `projectors` means no construction site breaks before it's
  populated, so each task is independently green.
