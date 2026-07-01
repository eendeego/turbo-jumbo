# Sharded Safetensors: Grouping + Dtype Labels — Implementation Plan

**Goal:** Make the scanner group sharded `.safetensors` (and `.bin`) weight
files into a single model entry, and label safetensors models by their real
dtype (read from the file header) instead of `unknown`.

**Architecture:** Two pure-`lib/` changes, no UI/audit changes. (1) Extend the
split-shard regex from GGUF-only to `gguf|safetensors|bin`, so
`model-00001-of-00004.safetensors` shards collapse into the existing
`SplitGroup` shape the table and audit already render. (2) Read the dtype from
the safetensors header (an 8-byte length + JSON) when a weight file's filename
carries no quant token, so the model is labeled `BF16`/`F16`/… — which also
gives distinct same-repo variants distinct grouping keys.

## Why this is the whole fix (no audit/table change)

- `components/models/models-table.tsx`'s `buildModelRows` groups a model's
  files by `f.quant`, so two distinct files sharing a quant collapse to one
  row. Before this plan, every safetensors shard was a separate `SingleFile`
  with quant `unknown`, so a 4-shard model showed **one** file and only one
  shard was selectable/auditable.
- Grouping the shards into one `SplitGroup` means the model is a single file
  group with one quant — no collapse, and the audit route's existing
  split-shard branch audits **every** shard. The table already renders
  `SplitGroup` (shard counts, missing-shard state).
- Labeling by dtype replaces `unknown` and, in the rarer case of two non-shard
  safetensors variants in one repo (e.g. a BF16 and an F8 weight), gives them
  distinct quant keys so they don't collapse either.

So `buildModelRows`, the audit (`lib/audit.ts`,
`app/api/v1/audit/route.ts`), and source resolution need **no** changes —
sharded safetensors in the hub cache already resolve per-shard via the
cache-path work; this plan only fixes the scan-time grouping and label.

**Out of scope (deferred):** flat-layout generic-name identity; whole-model
completeness via `model.safetensors.index.json` / companion files;
cold-presence & peer basename joins for generic names; the `hf-files`
download `.gguf` filter.

## File structure

- `lib/safetensors.ts` — `readSafetensorsDtype(fullPath)`: read the header,
  return the dominant tensor dtype. One responsibility; the only new I/O.
- `lib/safetensors.test.ts` — header-read tests.
- `lib/models.ts` — extend `SPLIT_RE`; add a `weightLabel` helper; apply it in
  both scan branches.
- `lib/models.test.ts` — sharded-grouping and dtype-label tests.

## Tasks (all implemented; see the individual commits)

1. **Read the dtype from a safetensors header** — `lib/safetensors.ts`.
2. **Group sharded safetensors / bin files** — extend `SPLIT_RE` to
   `/^(.+)-(\d+)-of-(\d+)\.(gguf|safetensors|bin)$/i`. The existing
   `${base}.gguf` arguments to `extractQuant`/`extractModelName` stay
   as-is: `stripExtension` strips `gguf|safetensors|bin` alike, so appending
   `.gguf` to the base is extension-agnostic and correct.
3. **Label weight files** — a filename quant token wins; a tokenless
   safetensors file is labeled by its header dtype (read once per group, from
   the first shard encountered); a tokenless `.bin` gets a generic `pytorch`
   tag; a tokenless GGUF keeps `unknown` (unchanged behavior).

## Non-breaking guarantee

GGUF scanning is unchanged — `weightLabel` returns the existing token for
tokenful files and leaves a tokenless GGUF as `unknown`; `SPLIT_RE`'s new
capture group is unused by the index/total logic. No UI or audit file is
touched.
