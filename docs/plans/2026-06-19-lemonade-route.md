# Lemonade Route Implementation Plan

**Goal:** Move the Lemonade browser from a client-toggled sub-tab into a real
nested route `/<peer>/download/lemonade` (and `/download/lemonade` for All).

**Architecture:** Keep the single optional catch-all
`app/[[...location]]/page.tsx`. A new `parseRoute` in `lib/locations.ts`
interprets a trailing `download/lemonade` and the page branches between
`HomeClient` (table) and a new `LemonadeClient`. A shared
`useInventoryLocations` hook feeds both clients the same peer/cold inventory.
`ModelKindTabs` and `LocationTabs` become navigation (links) instead of
client toggles.

Spec: `docs/specs/2026-06-19-lemonade-route-design.md`

## Task 1: Route parsing helpers (`lib/locations.ts`)

Add alongside the existing `resolveLocation`/`locationHref`:

- `type RouteView = 'table' | 'lemonade'`
- `parseRoute(segments, peers): {location, view} | null` — detects a trailing
  `['download', 'lemonade']`, resolves the remaining 0–1 segments through
  `resolveLocation`, and rejects the combination when the resolved location is
  `COLD_STORAGE_LOCATION` (no Lemonade there). Any other malformed shape
  (more than one leading segment, extra trailing segments, an unknown slug)
  returns null.
- `lemonadeHref(id, peers): string` — `ALL_LOCATION` → `/download/lemonade`;
  a peer → `/<slug>/download/lemonade`; `COLD_STORAGE_LOCATION` falls back to
  `/cold-storage` (not expected to be called with it).

Tests (`lib/locations.test.ts`, new): root/cold-storage/peer-slug/unknown-slug
for the table view; `download/lemonade` and `<slug>/download/lemonade` for the
lemonade view; cold-storage + lemonade → null; malformed shapes → null;
`lemonadeHref` for All and a peer; a round-trip `lemonadeHref` → `parseRoute`
yields the same location with `view: 'lemonade'`.

## Task 2: Shared inventory hook

New `components/models/use-inventory-locations.ts`: wraps `usePeerModels`
(one polling loop) and derives `seededPeerModels` (the local peer seeded from
server-rendered data so it's populated before the first poll lands) and
`inventoryLocations` (every peer + cold storage, for the Lemonade browser's
presence checks) — the same computation currently inlined in
`components/home/home-client.tsx`.

`home-client.tsx` switches to consume the hook instead of `usePeerModels`
directly and drops its inlined `seededPeerModels`/`inventoryLocations` memos.

## Task 3: `LemonadeClient` component

New `components/lemonade/lemonade-client.tsx` — a trimmed client component for
the Lemonade route with no selection/audit/copy/delete state. Props mirror
what the page already scans: `activeLocation`, `coldModels`,
`localModelsPath`, `hfTokenSet`, `logLevel`, `peerConfigs`,
`localPeerAddress`, `localPeerModels`.

Renders the same chrome as `HomeClient` (`AppShell` + `Heading` "Turbo
Jumbo"), `LocationTabs` (active = `activeLocation`, switching location stays
in Lemonade except Cold Storage, which has none and drops to its table),
`ModelKindTabs` with `value="lemonade"` (`Turbo Jumbo` navigates back to the
location's table), and `LemonadeBrowser` fed by `useInventoryLocations`, with
`canDownload = activeLocation === 'all' || activeLocation === localPeerAddress`
and `onDownloaded` re-fetching the local peer's models.

## Task 4: Wire routing and make tabs navigate

`app/[[...location]]/page.tsx`: replace `resolveLocation` with `parseRoute`;
`notFound()` on null. Scan models as today, then render `LemonadeClient` when
`view === 'lemonade'`, otherwise `HomeClient` as before.

`components/home/home-client.tsx`:

- Drop `inventoryLocations` from its `useInventoryLocations` destructure (no
  longer used here) and the `LemonadeBrowser` import.
- Drop the `modelKind` state and the effect/reset logic that clears it on
  location change — the table view always renders the table now.
- `ModelKindTabs` stays, `value="turbo-jumbo"`; selecting **Lemonade**
  navigates via `router.push(lemonadeHref(activeLocation, peerConfigs))`
  instead of toggling state.
- The former `showKindTabs && modelKind === 'lemonade' ? (...) : (...)`
  conditional collapses to always rendering the Turbo Jumbo body (the HF Add
  button when `canDownloadLocally`, the table) — the Lemonade branch is gone,
  now living on its own route.

## Verification

- `bun typecheck`, `bun lint`, `bun test` (new + existing pass), a production
  build.
- Manual: navigate `/`, `/<peer>`, `/cold-storage`, and their
  `/download/lemonade` variants; confirm the tab toggles navigate; confirm
  switching peers on the Lemonade page stays in Lemonade and Cold Storage
  drops to the table; a bad path like `/cold-storage/download/lemonade` or
  `/foo/bar` 404s.

## Self-review

- `refreshLocalModels`/`refreshPeerModels` in `home-client.tsx` are unrelated
  to the Lemonade removal (they back the delete/download-runner refreshes) —
  left in place, only removed if the typecheck flags them dead.
- `ModelKind` type import stays wherever `ModelKindTabs`'s `value` prop is
  still typed by it.
