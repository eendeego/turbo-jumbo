# Move Lemonade content to a `/<peer>/download/lemonade` route

## Goal

Today the Lemonade browser is a client-toggled sub-tab: inside each location,
`ModelKindTabs` switches between **Turbo Jumbo** (the models table) and
**Lemonade** (`LemonadeBrowser`), driven by `modelKind` state in `HomeClient`.

Move the Lemonade content to a real nested route so it has its own URL:

- All → `/download/lemonade`
- Each peer → `/<slug>/download/lemonade`
- Cold Storage has no Lemonade (unchanged).

The **Lemonade** tab in `ModelKindTabs` stays, but selecting it now navigates to
the route instead of toggling client state.

## Scope

Routes that get a Lemonade view match where the tab appears today: the **All**
view and every peer (local and remote). Remote peers stay browse-only
(`canDownload === false`). Cold Storage is unaffected.

Out of scope: any `/download` index page, exposing Hugging Face download at a
route, or changing `LemonadeBrowser` itself.

## Approach

Keep the existing single optional catch-all (`app/[[...location]]/page.tsx` +
`resolveLocation`). Parse the URL segments to detect a trailing
`download/lemonade` and branch the page between the table client and a new
Lemonade client. This is the smallest change, avoids Next.js route-collision
issues between an optional catch-all and explicit nested folders, and keeps all
routing centralized — consistent with the current design.

Rejected: explicit nested route folders (`app/page.tsx`,
`app/[location]/page.tsx`, `app/download/lemonade/page.tsx`,
`app/[location]/download/lemonade/page.tsx`). Cleaner per-route files but a
bigger refactor, forces removing the working catch-all, and makes `download` a
reserved top-level slug.

## Changes

### 1. Route parsing — `lib/locations.ts`

Add a route parser alongside the existing `resolveLocation`/`locationHref`:

```ts
type RouteView = 'table' | 'lemonade';

function parseRoute(
  segments: string[] | undefined,
  peers: Peer[],
): {location: string; view: RouteView} | null;
```

Behavior:

- `[]` → `{location: all, view: 'table'}`
- `['cold-storage']` → `{cold-storage, 'table'}`
- `['<slug>']` → `{peer, 'table'}` (or `null` for an unknown slug)
- `['download','lemonade']` → `{all, 'lemonade'}`
- `['<slug>','download','lemonade']` → `{peer, 'lemonade'}`
- `['cold-storage','download','lemonade']` → `null` (no Lemonade in cold storage)
- any other shape → `null`

Implementation: strip a trailing `['download','lemonade']` to set
`view: 'lemonade'`, then resolve the remaining 0–1 segments by reusing
`resolveLocation`. Reject `lemonade` when the resolved location is
`COLD_STORAGE_LOCATION`.

Add `lemonadeHref(id, peers)`:

- `ALL_LOCATION` → `/download/lemonade`
- peer → `/<slug>/download/lemonade`
- `COLD_STORAGE_LOCATION` → not expected; fall back to `/cold-storage`.

### 2. Page entry — `app/[[...location]]/page.tsx`

Replace the `resolveLocation` call with `parseRoute`. On `null`, `notFound()`.
Scan models as today, then render based on `view`:

- `table` → `<HomeClient .../>` (props unchanged)
- `lemonade` → `<LemonadeClient .../>`

### 3. Shared inventory hook — `components/models/use-inventory-locations.ts`

Extract the `seededPeerModels` + `inventoryLocations` computation currently
inline in `HomeClient` into a hook:

```ts
function useInventoryLocations(args: {
  peerConfigs: Peer[];
  localPeerAddress: string | null;
  localPeerModels: Model[];
  coldModels: Model[];
}): {
  seededPeerModels: Map<string, PeerModels>;
  inventoryLocations: InventoryLocation[];
};
```

It calls `usePeerModels()` internally. `HomeClient` switches to consume it (it
still needs `seededPeerModels` elsewhere, so the hook returns both).
`LemonadeClient` uses it for the browser's inventory.

### 4. New `components/lemonade/lemonade-client.tsx`

A trimmed client component for the Lemonade route — no selection, audit, copy,
or delete state. Props mirror what the page already scans:
`activeLocation`, `coldModels`, `localModelsPath`, `hfTokenSet`, `logLevel`,
`peerConfigs`, `localPeerAddress`, `localPeerModels`.

Renders:

- `AppShell` + `Heading` "Turbo Jumbo" (same chrome as `HomeClient`)
- `LocationTabs` (active = `activeLocation`)
- `ModelKindTabs` with `value="lemonade"`
- `LemonadeBrowser` with `inventoryLocations` from the shared hook,
  `canDownload = activeLocation === 'all' || activeLocation === localPeerAddress`,
  and `onDownloaded` re-fetching the local peer's models (same as
  `refreshLocalModels` in `HomeClient`).

### 5. Navigation (tabs as links)

`ModelKindTabs` and `LocationTabs` already take callbacks; the value now derives
from the route and the callbacks navigate:

- **`HomeClient` (table view):** `ModelKindTabs` value `'turbo-jumbo'`; selecting
  **Lemonade** → `router.push(lemonadeHref(activeLocation, peerConfigs))`.
  Remove the `modelKind` state and the `modelKind === 'lemonade'` branch — the
  table view always renders the table now.
- **`LemonadeClient` (lemonade view):** `ModelKindTabs` value `'lemonade'`;
  selecting **Turbo Jumbo** → `router.push(locationHref(activeLocation, peerConfigs))`.
- **`LocationTabs` on the Lemonade view:** switching to another peer or All →
  `router.push(lemonadeHref(id, peerConfigs))` (stay in Lemonade); switching to
  **Cold Storage** → `router.push(locationHref('cold-storage', peerConfigs))`
  (the table, since Cold Storage has no Lemonade).
- **`LocationTabs` on the table view:** unchanged (`locationHref`).

### 6. Testing — `lib/locations.test.ts`

Unit tests for the pure routing helpers:

- `parseRoute` for each shape above, including the cold-storage rejection,
  unknown slug → `null`, and bad shapes → `null`.
- `lemonadeHref` for All and a peer; round-trip `lemonadeHref` → `parseRoute`
  yields the same location with `view: 'lemonade'`.

## Verification

- `bun typecheck`, `bun lint`, `bun test` (new + existing pass).
- Manual: navigate `/`, `/<peer>`, `/cold-storage`, and their
  `/download/lemonade` variants; confirm the tab toggles navigate; confirm
  switching peers on the Lemonade page stays in Lemonade and Cold Storage drops
  to the table.
