# Per-file provenance hovercard

## Goal

Give every file-bearing row in an expanded model the equivalent of the model
row's sidecar hovercard: a per-file provenance card drawn from the file's
`tjmodel.json` record (source revision, sizes, checksums, origin link), with the
locally-observed values surfaced only when they diverge from the recorded
source.

## Scope

- **Every file-bearing row** gets a hovercard on its name: single-file quant
  rows, individual shard rows (depth 2), whole-repo file rows, projector rows,
  and split-quant parent rows.
- **Single-file rows** (single quant, shard, whole-repo file, projector) show
  full per-file provenance.
- **Split-quant parent rows** show an aggregate across their shards (the model
  card's shape, reused), since each shard already gets its own card.
- Matching of sidecar records to rows happens **server-side** at each data
  source; the client only renders what's attached. Rows with no sidecar record
  (sidecar-less models, missing files) render plain text — no hovercard.

## Data model

New, fs-free, serializable type in `lib/sidecar-types.ts`:

```ts
export interface FileProvenance {
  originUrl: string;
  sourceCommit?: string;
  sourceCommitDate?: string;
  sourceSize: number;
  computedSize: number;
  sourceSha256: string;
  computedSha256: string;
  missing?: boolean;
}
```

A helper to drop a `TjModelFile`'s manifest key into a `FileProvenance`:

```ts
export function fileProvenance(f: TjModelFile): FileProvenance;
```

A helper for the split-quant aggregate, reusing `SidecarSummary`:

```ts
export function summarizeFiles(
  modelUrl: string,
  repoId: string,
  files: TjModelFile[],
): SidecarSummary; // sourceCommit = deriveModelCommit(files); no repoCommit
```

## Data path

### Quant and shard rows (the scan → `buildModelRows`)

1. `scanModels` already reads the model sidecar (`modelSidecarSummary`). Extend
   it to also attach the raw per-file records: `Model.sidecarFiles?:
TjModelFile[]` (the sidecar's `files`, preserved as-is; absent when no
   sidecar).
2. `buildModelRows` builds, per model name, a manifest-key → `TjModelFile` map
   from `sidecarFiles`, **cold first then local so local wins** (consistent with
   the existing `sidecar` summary preference). The manifest key for a quant's
   storage-relative path `p` is `modelDirForRepo(p, modelName)?.key`
   (`modelDirForRepo` is imported from `@/lib/model-sidecar`, server-side).
3. For each `QuantInfo`:
   - **Single-file quant / projector:** look up its one path's record; attach
     `QuantInfo.provenance?: FileProvenance` when found.
   - **Split quant:** attach `QuantInfo.provenanceAggregate?: SidecarSummary`
     (from `summarizeFiles` over the shards' records, when any are found), and
     attach each shard's own record as `ShardInfo.provenance?: FileProvenance`.
4. `augmentWithPeerOnlyQuants` builds peer-only `QuantInfo`s with no sidecar —
   `provenance`/`provenanceAggregate` stay undefined. Unchanged.

### Whole-repo file rows (`repoFileStatuses`)

`repoFileStatuses` already reads each present file's sidecar meta
(`readFileMetaByPath`). Attach `RepoFile.provenance?: FileProvenance` from that
meta (it returns a `TjMeta`, whose fields match `FileProvenance`). Files whose
meta isn't read (missing files; size-mismatch-invalid files, judged before the
meta read) carry no provenance — no card.

### Rows (`buildDisplayRows`)

`DisplayRow` gains:

- `provenance?: FileProvenance` — set on single-file quant rows (from
  `QuantInfo.provenance`), shard rows (from `ShardInfo.provenance`), and
  whole-repo file rows (from `RepoFile.provenance`).
- `provenanceAggregate?: SidecarSummary` — set on split-quant parent rows (from
  `QuantInfo.provenanceAggregate`).

`buildDisplayRows` copies these onto the rows it already builds; it does no
matching itself.

## Hovercard UI (`components/cells/name-cell.tsx`)

### Single-file rows — new `FileProvenanceInfo`

Rendered for single-file quant, shard, whole-repo file, and projector rows when
`row.provenance` is set. Layout follows the existing `SidecarInfo`/`InfoRow`
pattern (label/value rows). The model URL for commit links is reconstructed as
`https://huggingface.co/${row.parentName}`.

```
Source revision   a1b2c3d4e5f6 ↗ (2026-06-12)
Source size       12.4 GB
Source sha256     <full hash, monospace, break-all>
⚠ On disk         12.5 GB
⚠ Computed sha256 <full hash, monospace, break-all>
View file on Hugging Face ↗
```

- **Source revision** = `sourceCommit` via the existing `CommitLink` + `(YYYY-MM-DD)`
  from `sourceCommitDate`. Omitted when no `sourceCommit`.
- **Source size** = `formatSize(sourceSize)`.
- **Source sha256** = full hash, monospace, `break-all`. Omitted when empty.
- **On disk** = `formatSize(computedSize)`, shown **only when** `computedSize > 0
&& computedSize !== sourceSize`. Error formatting: a `warning` icon and red
  text (`text-red-600 dark:text-red-400`).
- **Computed sha256** = full hash, shown **only when** `sourceSha256 &&
computedSha256 && computedSha256 !== sourceSha256`. Same error formatting.
- **View file on Hugging Face ↗** links `originUrl` (audit-cell wording/style).

A new `MismatchRow` (label + value in the warning/error style) renders the two
divergence lines; the matching lines use the existing `InfoRow`.

### Split-quant parent rows — reuse `SidecarInfo`

When `row.provenanceAggregate` is set, wrap the split row's label in a
`HoverCard` whose content is `<SidecarInfo sidecar={row.provenanceAggregate} />`.
With no `repoCommit`, `SidecarInfo` renders just Source revision (shared hash or
`mixed`) and Files (shard count · total source size).

### Mechanics

Each target row currently renders a plain `<Text>`/`<Token>` label. Wrap that
label in a `HoverCard` only when the row carries the relevant data
(`provenance` for single-file rows, `provenanceAggregate` for split rows);
otherwise leave it as plain text — the same guard the model card uses. The model
row's existing hovercard is unchanged.

## Testing

- `fileProvenance` (pure): maps a `TjModelFile` to a `FileProvenance`.
- `summarizeFiles` (pure): derives shared `sourceCommit` / `mixed`, file count,
  total source size; no `repoCommit`.
- `scanModels`: attaches `sidecarFiles` (temp-dir test, extends the Task-2 test
  fixture).
- `buildModelRows`: single-file quant gets `provenance` from the local sidecar
  (cold fallback); split quant gets `provenanceAggregate` and per-shard
  `provenance`; sidecar-less model gets neither.
- `repoFileStatuses`: a present file with a sidecar gets `provenance` (temp-dir
  test in the existing repo-files suite).
- `buildDisplayRows`: `provenance` lands on single-file quant / shard /
  whole-repo file rows; `provenanceAggregate` lands on split-quant rows.

UI rendering is verified by inspection in the running app, consistent with the
other hovercards in this codebase.

## Out of scope

- Provenance on missing files and size-mismatch-invalid whole-repo files (no
  meta read for those).
- Any change to how sidecars are written or audited.
- Changing the model row's existing hovercard.
