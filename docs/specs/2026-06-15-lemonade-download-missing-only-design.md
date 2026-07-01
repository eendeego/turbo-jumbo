# Download only the missing files for a partial Lemonade model

**Date:** 2026-06-15
**Status:** Approved (pending spec review)

## Summary

When the user downloads a Lemonade model that is already partially present in
local storage, request only the files that are missing locally rather than the
model's full variant file set. Downloads land in local storage, so "missing" is
judged against the local copy.

Today `startDownload` resolves the full variant file set and hands all of it to
the HF downloader. The `hf` CLI already skips complete files, but the
post-download source-recording pass then re-audits (re-hashes) every requested
file, including the ones that were already complete. Requesting only the missing
files makes the intent explicit and limits the audit pass to the newly fetched
files.

## Decisions (from brainstorming)

- **Relative to local only.** A file is missing unless it is already present in
  the local storage location (where downloads land). A copy that exists only in
  cold storage or on a peer is still downloaded.
- **Presence by the existing rule, no size check.** A file counts as present if
  it exists on disk: a non-`missing` single file, or a present shard of a split
  group. Bytes/size are not verified (same limitation as the existing "partial"
  badge — a truncated single file is treated as present).
- **Proceed anyway when nothing is missing.** If every variant file is already
  present locally, fall back to requesting the full set (current behavior); the
  `hf` CLI skips the complete files.

## Changes

### `lib/lemonade.ts`

1. Add an optional flag to `InventoryLocation` so consumers can find the local
   location (its `name` is the local peer's display name, not a fixed string):

   ```ts
   export interface InventoryLocation {
     name: string;
     models: Model[];
     isLocal?: boolean; // the location downloads land in
   }
   ```

2. Add a pure, exported helper:

   ```ts
   /**
    * Of a variant's repo file paths, the basenames not already present in the
    * local scan for `repoId`. Present = a non-missing single file, or a present
    * shard of a split group — per-file existence, no size check. Returns all
    * paths when none are present locally; callers fall back to the full set when
    * the result is empty.
    */
   export function missingVariantFiles(
     paths: string[],
     localModels: Model[],
     repoId: string,
   ): string[];
   ```

   Implementation: build a `Set<string>` of present basenames by iterating
   `localModels` where `m.name === repoId`; for each file, a `SingleFile` with
   `missing === false` contributes its `filename`, a `SplitGroup` contributes
   `basename(s.path)` for each present shard in `files`. Return
   `paths.filter((fp) => !present.has(basename(fp)))`, where
   `basename(p) = p.split('/').pop() ?? p`.

### `components/home/home-client.tsx`

When building `inventoryLocations`, mark the local peer's entry:

```ts
const locs: InventoryLocation[] = peerConfigs.map((p) => {
  const lo = seededPeerModels.get(p.address);
  return {
    name: p.name,
    models: lo?.type === 'value' ? lo.value : [],
    isLocal: p.address === localPeerAddress,
  };
});
locs.push({name: 'cold storage', models: coldModels});
```

(The cold-storage entry stays `isLocal` unset/false.)
`hugging-face-download.tsx` passes `inventoryLocations` through unchanged.

### `components/lemonade/lemonade-browser.tsx` — `startDownload`

After `matchVariantFiles` produces the full set:

```ts
const all = matchVariantFiles(files, selected.variant, selected.mmproj);
if (all.length === 0) {
  setResolveError(
    `No files in ${selected.repoId} match "${selected.variant ?? 'any gguf'}".`,
  );
  return;
}
const localModels = inventoryLocations.find((l) => l.isLocal)?.models ?? [];
const missing = missingVariantFiles(all, localModels, selected.repoId);
const filePaths = missing.length > 0 ? missing : all;
// ...then start({repoId, branch, filePaths, sendToCold, deleteAfterTransfer})
```

The existing variant-match guard stays on `all`; the missing/fallback logic sits
after it. Everything downstream is unchanged — the source-recording pass audits
exactly the requested files, and the optional cold-storage copy follows.

## Testing

Unit tests for `missingVariantFiles` in `lib/lemonade.test.ts`:

- All variant files present locally → `[]`.
- None present locally → all paths returned unchanged.
- A partial split group (some shards present) → only the missing shard paths.
- A present single file is excluded; an absent one is included.
- Files belonging to a different `repoId` are ignored (not treated as present).

No component-level test (the browser has none); the `startDownload` wiring is a
one-line subset swap covered by the helper's tests and typechecking.

## Out of scope

- Size/byte verification of present files (explicitly not done).
- Re-auditing files that were already complete (they are no longer requested, so
  they are not re-hashed — this is the intended efficiency gain).
- Any change to the "partial"/"downloaded" badge logic.
