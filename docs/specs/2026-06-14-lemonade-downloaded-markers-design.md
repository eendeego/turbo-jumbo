# Lemonade browser: "already downloaded" markers

## Goal

When the Lemonade model catalog is shown (`LemonadeBrowser`), mark each entry
that is already present on disk, so the user can tell at a glance what they have
versus what they'd be fetching. The marker distinguishes a **complete** copy
from a **partial** one, and reports presence across **local storage, cold
storage, and peer hosts**.

## Background

- `LemonadeBrowser` lists catalog entries (`LemonadeModel`), each resolving to an
  HF `repoId` plus a `variant` — a quant token (`Q4_0`), an exact `.gguf`
  filename, or `null` (the whole repo). Files are only resolved to a concrete
  list when an entry is selected and downloaded; the catalog list itself carries
  no per-entry HF file listing.
- `scanModels()` (`lib/models.ts`) walks a storage root and returns `Model[]`.
  Crucially it decodes the **huggingface_hub cache layout**
  (`models--<org>--<repo>/snapshots/<commit>/…`) back to the `repoId` and uses it
  as the model `name`. Lemonade / `hf` downloads land in exactly this layout, so
  a downloaded Lemonade entry is reliably named by its repo id. Sharded GGUFs are
  returned as `SplitGroup`s carrying `presentShards` / `totalShards` (derived from
  the `-NNNNN-of-MMMMM` filename), so shard completeness is known without any HF
  fetch.
- All three inventories already converge in `home-client.tsx`: `localPeerModels`
  (the local host scan), `coldModels` (cold storage scan), and live `peerModels`
  from `usePeerModels()`. `seededPeerModels` is `peerModels` with the local host
  seeded in. `home-client` is the parent that renders `HuggingFaceDownload`,
  which renders `LemonadeBrowser`.

## Design decisions

These were settled during brainstorming:

1. **Match basis: full / exact (complete vs partial).** Not just "repo present"
   — distinguish a complete copy from an incomplete one.
2. **Scope: local + cold + peers.** A copy in any of the three counts.
3. **Marker: status token + location tooltip.** A small token per row, with a
   tooltip naming where the copy lives.
4. **Completeness is computed from local scan data, not per-entry HF fetches.**
   Shard counts come from the `-of-` filename (`SplitGroup`), and the `mmproj`
   companion is named in the catalog entry itself, so "complete vs partial" needs
   no network call.

## Components

### 1. Matching function — `lib/lemonade.ts` (pure, tested)

```ts
type DownloadStatus = 'none' | 'partial' | 'complete';

interface InventoryLocation {
  name: string; // "local", "cold storage", "my-server", …
  models: Model[]; // that location's scan; Model imported type-only
}

interface LemonadeDownloadInfo {
  status: DownloadStatus; // best across locations
  locations: Array<{name: string; status: 'partial' | 'complete'}>;
}

export function lemonadeDownloadStatus(
  model: LemonadeModel,
  locations: InventoryLocation[],
): LemonadeDownloadInfo;
```

Import `Model` (and the file types it needs) with `import type` only, so the
server-only scanner runtime is never pulled into the client bundle (matching the
existing constraint that produced the "Keep the server-only scanner out of the
client bundle" commit).

**Per-location evaluation:**

1. Select scanned `Model`s whose `name === model.repoId`. (A flat-layout GGUF
   without a sidecar is named by filename, not repo, and won't match — an
   accepted limitation; Lemonade downloads use the cache layout and do match.)
2. From those models' files, pick the groups matching `variant`, reusing the
   same selection rules as `matchVariantFiles`:
   - exact `.gguf` filename → file whose basename equals the variant
     (case-insensitive);
   - quant token → file whose `quant` label equals the token (case-insensitive),
     or whose filename contains it, excluding `mmproj*`;
   - `null` → any non-`mmproj` gguf in the repo.
3. If no group matches → this location is `none`.
4. Otherwise **complete** when every matched group is whole — a `SplitGroup` has
   `presentShards === totalShards`; a `SingleFile` is present (`!missing`) — and,
   when the entry names an `mmproj`, a file with that basename is present in this
   same location. Anything short of that is **partial**.

**Aggregate:** overall `status` is the best across locations (`complete` >
`partial` > `none`); `locations` lists each location that isn't `none`, with its
own per-location status, in the order the locations were supplied.

### 2. Wiring — `home-client.tsx` → `HuggingFaceDownload` → `LemonadeBrowser`

`home-client` builds `InventoryLocation[]` with no new fetching:

- one entry per peer config — `{name: peer.name, models: <value of the peer's
seeded model AsyncState>}` (empty array when that peer's `AsyncState` isn't a
  loaded value). The seeded peer map already seeds the local host, so the local
  host is covered here under its configured name.
- plus `{name: 'cold storage', models: coldModels}`.

This array is passed as a new prop to `HuggingFaceDownload`, which forwards it
unchanged to `LemonadeBrowser`. Re-renders on peer polls are negligible.

### 3. UI — `lemonade-browser.tsx`

- A `useMemo` over the loaded catalog produces per-row status via
  `lemonadeDownloadStatus`, recomputed when the catalog or the inventory
  locations change.
- In each row, render a `Badge` when `status !== 'none'`:
  - `complete` → `label="downloaded"`, `variant="green"`;
  - `partial` → `label="partial"`, `variant="yellow"` (amber).
- The badge's tooltip (via `HoverCard`) summarizes locations, grouping by
  status, e.g. `Complete: local. Partial: my-server.` (omit an empty group).

No change to selection, resolution, or the download flow — this is display only.

## Data flow

```
home-client (localPeerModels + coldModels + seeded peer models)
  → InventoryLocation[]
    → HuggingFaceDownload (forwards)
      → LemonadeBrowser
        → lemonadeDownloadStatus(entry, locations) per catalog row
          → Badge (green "downloaded" / amber "partial") + tooltip
```

## Error handling

- A peer whose `AsyncState` is loading/error/empty contributes an empty
  `models` array — it simply doesn't mark anything, never throws.
- The function tolerates malformed/empty inventories (returns `none`), matching
  the catalog parser's existing tolerance for a moving upstream source.

## Testing

Add cases to `lib/lemonade.test.ts` for `lemonadeDownloadStatus`:

- exact-filename variant present → `complete`;
- quant-token variant present (case-insensitive label match) → `complete`;
- whole-repo (`null`) variant with a gguf present → `complete`;
- sharded group missing a shard → `partial`;
- entry with `mmproj` whose projector file is absent → `partial`;
- no matching repo/variant → `none`;
- present in two locations (one complete, one partial) → overall `complete`,
  `locations` lists both with their own statuses in input order.

## Out of scope

- Per-entry HF file fetching for exhaustive completeness of multi-file,
  non-sharded whole-repo entries (accepted limitation above).
- Any change to the download, resolve, copy-to-cold, or delete flows.
- Markers anywhere other than the Lemonade catalog browser.
