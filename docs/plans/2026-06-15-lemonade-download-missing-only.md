# Download only missing files for a partial Lemonade model — Implementation Plan

**Goal:** When downloading a Lemonade model already partially present in
local storage, request only the locally-missing files instead of the full
variant set.

**Architecture:** A pure `missingVariantFiles(paths, localModels, repoId)`
helper in `lib/lemonade.ts` filters the resolved variant paths against the
local scan (per-file existence, no size check). `InventoryLocation` gains an
`isLocal?` flag so the browser can pick the local location; `home-client.tsx`
sets it; `lemonade-browser.tsx`'s `startDownload` passes the missing subset
(falling back to the full set when nothing is missing).

Spec: `docs/specs/2026-06-15-lemonade-download-missing-only-design.md`

## Task 1: `isLocal` flag + `missingVariantFiles` helper in `lib/lemonade.ts`

Add the field:

```ts
export interface InventoryLocation {
  name: string;
  models: Model[];
  isLocal?: boolean; // the location downloads land in
}
```

Add the helper (placed after `matchVariantFiles`, its natural sibling — both
map a variant to its repo file paths):

```ts
/**
 * Of a variant's repo file paths, the ones not already present in the local
 * scan for `repoId`. Present is judged per file by existence (no size check): a
 * non-`missing` single file contributes its filename; a split group contributes
 * each present shard's basename. Matching is by basename. Returns all paths when
 * none are present locally; callers fall back to the full set when this is empty.
 */
export function missingVariantFiles(
  paths: string[],
  localModels: Model[],
  repoId: string,
): string[] {
  const basename = (p: string) => p.split('/').pop() ?? p;
  const present = new Set<string>();
  for (const m of localModels) {
    if (m.name !== repoId) continue;
    for (const f of m.files) {
      if (f.isSplit) {
        for (const s of f.files) present.add(basename(s.path));
      } else if (!f.missing) {
        present.add(basename(f.filename));
      }
    }
  }
  return paths.filter((fp) => !present.has(basename(fp)));
}
```

Tests: all variant files present locally → `[]`; none present → all paths
returned unchanged; a present single file excluded, an absent one included; a
`missing: true` single file treated as absent; a partial split returns only
the missing shard paths; files belonging to a different repo are ignored; a
path with a subdirectory still matches by basename.

## Task 2: mark the local inventory location in `home-client.tsx`

Change the peer-mapped `inventoryLocations` entry to carry `isLocal`:

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

The cold-storage entry intentionally leaves `isLocal` unset/false. No unit
test (this component isn't unit-tested); verified by typecheck.

## Task 3: request only the missing files in `lemonade-browser.tsx`

Import `missingVariantFiles` alongside the existing `@/lib/lemonade` imports.
In `startDownload`, after resolving the full variant set (`all`) and keeping
the existing empty-match guard on it, compute and use the missing subset:

```ts
const localModels = inventoryLocations.find((l) => l.isLocal)?.models ?? [];
const missing = missingVariantFiles(all, localModels, selected.repoId);
const filePaths = missing.length > 0 ? missing : all;
```

`filePaths` (not `all`) is what gets passed to the download runner.
`inventoryLocations` is already a prop of `LemonadeBrowser` (used by
`lemonadeDownloadStatus`). No unit test for the browser (none exist);
verified by typecheck, lint, prettier, and the full suite.

## Self-review

- `missingVariantFiles(paths, localModels, repoId): string[]` defined once,
  called identically at the one call site.
- `InventoryLocation.isLocal?: boolean` added once, set in `home-client.tsx`,
  read in `lemonade-browser.tsx` — no signature drift.
- Out of scope: size/byte verification, changes to the downloaded/partial
  badge logic. Reduced audit scope (fewer files re-hashed) is an intended
  consequence, not a separate change.
