# Lemonade Downloaded-Markers Implementation Plan

**Goal:** Mark each row of the Lemonade catalog browser as "downloaded"
(green) or "partial" (amber) when its files already exist in local storage,
cold storage, or on a peer host, with a tooltip naming where.

**Architecture:** A pure function `lemonadeDownloadStatus` in `lib/lemonade.ts`
decides each catalog entry's status from already-loaded scan data (`Model[]`
per location), using hub-cache repo names, shard counts, and the
catalog-named `mmproj`. `home-client.tsx` assembles the per-location
inventory it already holds and drills it through `HuggingFaceDownload` into
`LemonadeBrowser`, which renders a `Badge` per row with a `HoverCard` tooltip.

## File structure

- `lib/lemonade.ts` (modify) — add `DownloadStatus`, `InventoryLocation`,
  `LemonadeDownloadInfo` types and the pure functions
  `lemonadeDownloadStatus` + `lemonadeStatusTooltip`. Type-only import of
  `Model`/`ModelFile` so the server-only scanner runtime stays out of the
  client bundle.
- `lib/lemonade.test.ts` (modify) — unit tests for the two new functions.
- `components/home/home-client.tsx` (modify) — build `InventoryLocation[]`
  from the peer configs + seeded peer models + cold models; pass to
  `HuggingFaceDownload`.
- `components/hf-download/hugging-face-download.tsx` (modify) — accept
  `inventoryLocations` prop, forward to `LemonadeBrowser`.
- `components/lemonade/lemonade-browser.tsx` (modify) — accept
  `inventoryLocations`, compute per-row status, render the marker + tooltip.

## Tasks

### Task 1: Pure matching + tooltip functions in `lib/lemonade.ts`

Add `lemonadeDownloadStatus(model, locations)` and
`lemonadeStatusTooltip(info)`:

- The hub-cache scan names a model by its repo id, which is where Lemonade
  downloads land — so `model.repoId` is the join key against each location's
  `Model[]`.
- Matched weight groups mirror `matchVariantFiles`'s selection rules (exact
  filename / quant token / any non-mmproj gguf for a whole-repo entry), but
  evaluated over already-scanned `ModelFile`s.
- A group counts complete when every shard is present (split) or the file
  isn't `missing` (single); the catalog's named `mmproj` must also be present
  and complete when the entry declares one.
- Overall status is the best across locations (complete > partial > none);
  `locations` lists every non-`none` location with its own status, in input
  order.
- `lemonadeStatusTooltip` groups location names by status into a sentence,
  e.g. `Complete: cold storage, local. Partial: my-server.`.

Test cases: exact-filename match, quant-token match (case-insensitive),
whole-repo match, missing shard → partial, missing mmproj → partial, present
mmproj → complete, no match → none, best-across-locations with order
preserved, and the tooltip grouping.

### Task 2: Drill per-location inventory into the Lemonade browser

Wiring only — no marker rendered yet.

- `home-client.tsx`: build `inventoryLocations` — one entry per configured
  peer (`{name: peer.name, models: <that peer's loaded models, or [] if not
loaded>}`, with the local host already seeded under its own name) plus
  `{name: 'cold storage', models: coldModels}`. Pass as a prop to
  `HuggingFaceDownload`.
- `hugging-face-download.tsx`: accept `inventoryLocations` and forward
  unchanged to `LemonadeBrowser`.
- `lemonade-browser.tsx`: accept the prop (rendering added in Task 3).

### Task 3: Render the marker + tooltip

- A `useMemo` computes `lemonadeDownloadStatus` per catalog row.
- Render a `Badge` immediately before the existing "suggested" badge when
  status isn't `none`: `variant="green"` + `label="downloaded"` for complete,
  `variant="orange"` + `label="partial"` otherwise, wrapped in a `HoverCard`
  showing `lemonadeStatusTooltip`'s text.
- No change to selection, resolution, or the download flow.

## Error handling

- A peer whose models haven't loaded contributes an empty array — it simply
  doesn't mark anything, never throws.
- The function tolerates malformed/empty inventories (returns `none`).

## Out of scope

- Per-entry HF file fetching for exhaustive completeness of multi-file,
  non-sharded whole-repo entries.
- Any change to the download, resolve, copy-to-cold, or delete flows.
- Markers anywhere other than the Lemonade catalog browser.
