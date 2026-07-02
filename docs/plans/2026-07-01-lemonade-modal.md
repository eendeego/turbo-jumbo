# Lemonade Modal (Intercepted Route) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the "Add from Lemonade" downloader as an Astryx `Dialog` over the models table, routed through a Next.js intercepted route (`@modal` parallel slot), replacing the full-page Lemonade view.

**Architecture:** The `AppChrome` layout moves from `app/[[...location]]/layout.tsx` up into a new `(chrome)` route group whose layout also renders a `@modal` slot. The Lemonade URLs (`/download/lemonade`, `/<peer>/download/lemonade` — unchanged) become explicit route folders beside the catch-all: interceptors in `@modal/` open the modal on soft nav; real pages render table + open modal on hard nav. Shared server components (`HomeView`, `LemonadeModalRoute`) keep the route files thin.

**Tech Stack:** Next.js 16 App Router (parallel + intercepting routes), React 19, Astryx `Dialog`/`DialogHeader`, Bun, Jujutsu (`jj`, not git).

Spec: `docs/plans/2026-07-01-lemonade-modal-design.md`

## Global Constraints

- Package manager/runtime is **Bun** (`bun`, `bunx`); version control is **Jujutsu** (`jj commit -m "…"`), no Co-Authored-By trailers.
- `app/` holds only routing; React components live in `components/`, grouped by feature.
- Astryx components imported by bare name (`@astryxdesign/core/Dialog`); buttons opening a modal end labels with `…` (not applicable here — the "From Lemonade" menu item navigates, label unchanged).
- URLs must not change: `/download/lemonade`, `/<peer-slug>/download/lemonade`; Cold Storage has no Lemonade view (404 on hard nav).
- All Lemonade/table pages export `const dynamic = 'force-dynamic'` (they read the live filesystem).
- Dev server for manual checks: `bun dev` (custom `server.ts` on http://localhost:3000).

---

### Task 1: Extract the `HomeView` server component

**Files:**
- Create: `components/home/home-view.tsx`
- Modify: `app/[[...location]]/page.tsx`

**Interfaces:**
- Consumes: existing `scanModels`, `getModelsTableData`, `HomeClient`, config exports.
- Produces: `HomeView({location}: {location: string})` — synchronous server component rendering the models table for one location tab. Tasks 4–5 import it from `@/components/home/home-view`.

- [ ] **Step 1: Create `components/home/home-view.tsx`**

```tsx
import {
  config,
  localModelsDir,
  coldStorageDir,
  lemonadeDir,
  localPeer,
} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {getModelsTableData} from '@/components/models/models-table';
import {HomeClient} from '@/components/home/home-client';

// Server-rendered models table for one location tab. Shared by the catch-all
// page and the hard-navigation Lemonade pages (which render it under the
// already-open download modal).
export function HomeView({location}: {location: string}) {
  const coldModels = scanModels(coldStorageDir);
  const localModels = scanModels(localModelsDir, lemonadeDir);
  const peerConfigs = config.peers.map((p) => ({
    ...p,
    isLocal: p === localPeer,
  }));
  const modelsTableData = getModelsTableData(localModels, coldModels);
  return (
    <HomeClient
      activeLocation={location}
      coldModels={coldModels}
      localModelsPath={localModelsDir ?? null}
      hfTokenSet={!!process.env.HF_TOKEN}
      modelsTableData={modelsTableData}
      peerConfigs={peerConfigs}
      localPeerAddress={localPeer?.address ?? null}
      localPeerModels={localModels}
    />
  );
}
```

- [ ] **Step 2: Use it from the catch-all page**

Replace `app/[[...location]]/page.tsx` with (the `hf` branch no longer scans models it never used; the `lemonade` branch keeps its scans inline until Task 4 removes it):

```tsx
import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {
  config,
  localModelsDir,
  coldStorageDir,
  lemonadeDir,
  localPeer,
} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {parseRoute} from '@/lib/locations';
import {HomeView} from '@/components/home/home-view';
import {LemonadeClient} from '@/components/lemonade/lemonade-client';
import {HfDownloadClient} from '@/components/hf-download/hf-download-client';

export function generateMetadata(): Metadata {
  return {title: `Turbo Jumbo - ${localPeer?.name ?? 'unknown'}`};
}

// Reads the live filesystem (local + cold storage), so render per-request
// rather than prerendering at build time.
export const dynamic = 'force-dynamic';

export default async function Home({
  params,
}: {
  params: Promise<{location?: string[]}>;
}) {
  const {location} = await params;
  const route = parseRoute(location, config.peers);
  if (route === null) notFound();
  const {location: activeLocation, view} = route;

  if (view === 'hf') {
    const peerConfigs = config.peers.map((p) => ({
      ...p,
      isLocal: p === localPeer,
    }));
    return (
      <HfDownloadClient
        activeLocation={activeLocation}
        localModelsPath={localModelsDir ?? ''}
        hfTokenSet={!!process.env.HF_TOKEN}
        peerConfigs={peerConfigs}
      />
    );
  }

  if (view === 'lemonade') {
    const coldModels = scanModels(coldStorageDir);
    const localModels = scanModels(localModelsDir, lemonadeDir);
    const peerConfigs = config.peers.map((p) => ({
      ...p,
      isLocal: p === localPeer,
    }));
    // Lemonade's own model cache lives outside the managed storage; scan it so
    // the Lemonade browser can flag catalog entries already present there.
    const lemonadeCacheModels = lemonadeDir ? scanModels(lemonadeDir) : [];
    return (
      <LemonadeClient
        activeLocation={activeLocation}
        coldModels={coldModels}
        localModelsPath={localModelsDir ?? ''}
        hfTokenSet={!!process.env.HF_TOKEN}
        peerConfigs={peerConfigs}
        localPeerAddress={localPeer?.address ?? null}
        localPeerModels={localModels}
        lemonadeCacheModels={lemonadeCacheModels}
      />
    );
  }

  return <HomeView location={activeLocation} />;
}
```

- [ ] **Step 3: Verify**

Run: `bun typecheck && bun lint && bun test`
Expected: all pass (no behavior change; `getModelsTableData` import moved out of the page).

- [ ] **Step 4: Commit**

```bash
jj commit -m "Extract the HomeView server component from the catch-all page"
```

---

### Task 2: `(chrome)` route group with a `@modal` slot

**Files:**
- Create: `app/(chrome)/layout.tsx` (moved from `app/[[...location]]/layout.tsx`)
- Create: `app/(chrome)/@modal/default.tsx`
- Move: `app/[[...location]]/` → `app/(chrome)/[[...location]]/`
- Delete: `app/[[...location]]/layout.tsx` (superseded by the group layout)

**Interfaces:**
- Produces: the group layout accepts `{children, modal}`; every route added under `app/(chrome)/` in Task 4 renders inside `AppChrome`, and `@modal/` children fill the `modal` slot.

- [ ] **Step 1: Move the routes into the group**

```bash
mkdir -p "app/(chrome)"
mv "app/[[...location]]" "app/(chrome)/[[...location]]"
mv "app/(chrome)/[[...location]]/layout.tsx" "app/(chrome)/layout.tsx"
```

- [ ] **Step 2: Add the `modal` slot to the layout**

Replace `app/(chrome)/layout.tsx` with:

```tsx
import type {ReactNode} from 'react';
import {config} from '@/lib/config';
import {AppChrome} from '@/components/chrome/app-chrome';

// Static shell wrapper. It carries no route params, so it never re-renders on
// navigation — AppChrome derives the active location from the URL client-side,
// which keeps the location tabs correct regardless of layout re-render timing.
// The `modal` slot hosts the intercepted Lemonade download modal and renders
// null (default.tsx) whenever no modal route is active.
export default function ChromeLayout({
  children,
  modal,
}: {
  children: ReactNode;
  modal: ReactNode;
}) {
  return (
    <AppChrome peers={config.peers} logLevel={config.log_level ?? 'info'}>
      {children}
      {modal}
    </AppChrome>
  );
}
```

- [ ] **Step 3: Create `app/(chrome)/@modal/default.tsx`**

```tsx
// The modal slot is empty except while a /download/lemonade route is active.
export default function ModalDefault() {
  return null;
}
```

- [ ] **Step 4: Verify routing still works**

Run: `bun typecheck`, then `bun dev` and:

```bash
for p in / /cold-storage /download/lemonade /download/hf /nonexistent; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "http://localhost:3000$p"; done
```

Expected: `200` for the first four, `404` for `/nonexistent` (plus a `200` for a configured peer slug, e.g. `/$(peer-slug)`).

- [ ] **Step 5: Commit**

```bash
jj commit -m "Move AppChrome into a (chrome) route group with a @modal slot"
```

---

### Task 3: `LemonadeModal` dialog + `LemonadeModalRoute` server component

**Files:**
- Create: `components/lemonade/lemonade-modal.tsx`
- Create: `components/lemonade/lemonade-modal-route.tsx`

**Interfaces:**
- Consumes: `Dialog`/`DialogHeader` (`@astryxdesign/core/Dialog`), `useInventoryLocations`, `LemonadeBrowser`, `downloadTarget`, `locationHref` — all existing.
- Produces: `LemonadeModal(props)` — client dialog, same props as today's `LemonadeClient`; `LemonadeModalRoute({location}: {location: string})` — server component that scans and renders it. Task 4's four route files import `LemonadeModalRoute` from `@/components/lemonade/lemonade-modal-route`.

- [ ] **Step 1: Create `components/lemonade/lemonade-modal.tsx`**

The state/refresh logic is carried over from `components/lemonade/lemonade-client.tsx` unchanged; the page chrome (heading, Back button, `LayoutContent`) is replaced by a `Dialog`:

```tsx
'use client';

import {useCallback, useEffect, useState} from 'react';
import {usePathname, useRouter} from 'next/navigation';
import {locationHref} from '@/lib/locations';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models';
import {LEMONADE_CATALOG_URL} from '@/lib/lemonade';
import {downloadTarget} from '@/lib/download-target';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Link} from '@astryxdesign/core/Link';
import {LemonadeBrowser} from '@/components/lemonade/lemonade-browser';
import {useInventoryLocations} from '@/components/models/use-inventory-locations';

/**
 * The "Add from Lemonade" download modal. Routed: soft navigation to
 * /download/lemonade (or /<peer>/download/lemonade) intercepts into the
 * @modal slot over the current table; hard navigation renders it over a
 * freshly rendered table. Closing navigates back to the location's table.
 */
export function LemonadeModal({
  activeLocation,
  coldModels,
  localModelsPath,
  hfTokenSet,
  peerConfigs,
  localPeerAddress,
  localPeerModels,
  lemonadeCacheModels: lemonadeCacheModelsProp,
}: {
  activeLocation: string;
  coldModels: Model[];
  localModelsPath: string;
  hfTokenSet: boolean;
  peerConfigs: PeerConfig[];
  localPeerAddress: string | null;
  localPeerModels: Model[];
  lemonadeCacheModels: Model[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const {handleModelsRefreshed, inventoryLocations} = useInventoryLocations({
    peerConfigs,
    localPeerAddress,
    localPeerModels,
    coldModels,
  });

  // Re-scan the local peer after a download so its status markers update.
  const refreshLocalModels = useCallback(async () => {
    const local = peerConfigs.find((p) => p.isLocal);
    if (!local) return;
    try {
      const res = await fetch(
        `/api/v1/peers/${encodeURIComponent(local.name)}/models`,
      );
      if (!res.ok) return;
      const models = (await res.json()) as Model[];
      handleModelsRefreshed(local.address, models);
    } catch {
      /* best-effort: the periodic poll will catch up */
    }
  }, [peerConfigs, handleModelsRefreshed]);

  // Models in Lemonade's own cache directory, seeded from the server scan and
  // re-fetched after a download so the browser's cache token stays current.
  const [lemonadeCacheModels, setLemonadeCacheModels] = useState(
    lemonadeCacheModelsProp,
  );
  const [prevCacheProp, setPrevCacheProp] = useState(lemonadeCacheModelsProp);
  if (prevCacheProp !== lemonadeCacheModelsProp) {
    setPrevCacheProp(lemonadeCacheModelsProp);
    setLemonadeCacheModels(lemonadeCacheModelsProp);
  }
  const refreshLemonadeCache = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/lemonade-cache');
      if (!res.ok) return;
      setLemonadeCacheModels((await res.json()) as Model[]);
    } catch {
      /* best-effort: the next page render reseeds from the server scan */
    }
  }, []);
  // Repo ids whose local copy is present but incomplete (missing files a full
  // download would include). Downloads land locally, so flag against the local
  // store; re-fetched after each download.
  const [incompleteRepos, setIncompleteRepos] = useState<Set<string>>(
    new Set(),
  );
  const refreshIncomplete = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/local-models/incomplete');
      if (!res.ok) return;
      const data = (await res.json()) as {incomplete?: string[]};
      setIncompleteRepos(new Set(data.incomplete ?? []));
    } catch {
      /* best-effort: the markers just won't show */
    }
  }, []);
  useEffect(() => {
    (async () => {
      await refreshIncomplete();
    })();
  }, [refreshIncomplete]);

  // A download can land in managed storage or the Lemonade cache, and changes
  // completeness — refresh all three when one finishes.
  const onDownloaded = useCallback(async () => {
    await Promise.all([
      refreshLocalModels(),
      refreshLemonadeCache(),
      refreshIncomplete(),
    ]);
  }, [refreshLocalModels, refreshLemonadeCache, refreshIncomplete]);

  // Closing navigates to the location's table. replace (not push/back) behaves
  // identically for soft and hard navigation and leaves no modal entry in
  // history, so Back after closing doesn't reopen it.
  const close = useCallback(() => {
    router.replace(locationHref(activeLocation, peerConfigs));
  }, [router, activeLocation, peerConfigs]);

  // Where the download runs: the All tab and the local peer download on this
  // machine; a remote peer's tab downloads on that peer via the proxy.
  const target = downloadTarget(activeLocation, peerConfigs, localModelsPath);
  // The inventory whose presence decides which files to skip: the machine the
  // download will run on (All → the local peer), identified by peer name to
  // match the InventoryLocation entries.
  const targetPeerAddress =
    activeLocation === 'all' ? localPeerAddress : activeLocation;
  const targetName =
    peerConfigs.find((p) => p.address === targetPeerAddress)?.name ?? null;
  // Any peer tab (and All) can download now; only Cold Storage has no Lemonade
  // view, and it never reaches here.
  const canDownload =
    activeLocation === 'all' ||
    peerConfigs.some((p) => p.address === activeLocation);

  // On soft navigation away (e.g. browser Back while open) Next keeps the
  // unmatched @modal slot's previous state mounted, so gate on the URL: only
  // render while it is still a Lemonade download route.
  if (!pathname.endsWith('/download/lemonade')) return null;

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      width="min(1100px, 92vw)"
      maxHeight="85vh"
      purpose="form"
    >
      <VStack gap={4}>
        <DialogHeader
          title="Add from Lemonade"
          onOpenChange={(open) => {
            if (!open) close();
          }}
        />

        {/* Where the catalog driving this modal comes from. */}
        <Text type="supporting">
          Catalog:{' '}
          <Link href={LEMONADE_CATALOG_URL} isExternalLink>
            {LEMONADE_CATALOG_URL.split('/').pop()}
          </Link>
        </Text>

        <LemonadeBrowser
          hfTokenSet={hfTokenSet}
          target={target}
          targetName={targetName}
          inventoryLocations={inventoryLocations}
          lemonadeCacheModels={lemonadeCacheModels}
          incompleteRepos={incompleteRepos}
          canDownload={canDownload}
          onDownloaded={onDownloaded}
        />
      </VStack>
    </Dialog>
  );
}
```

- [ ] **Step 2: Create `components/lemonade/lemonade-modal-route.tsx`**

```tsx
import {
  config,
  localModelsDir,
  coldStorageDir,
  lemonadeDir,
  localPeer,
} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {LemonadeModal} from '@/components/lemonade/lemonade-modal';

// Server side of the Lemonade download modal: scans the stores the modal
// needs and renders it. Shared by the intercepted (soft-nav) pages in the
// @modal slot and the real (hard-nav) pages, so the route files stay thin.
export function LemonadeModalRoute({location}: {location: string}) {
  const coldModels = scanModels(coldStorageDir);
  const localModels = scanModels(localModelsDir, lemonadeDir);
  // Lemonade's own model cache lives outside the managed storage; scan it so
  // the Lemonade browser can flag catalog entries already present there.
  const lemonadeCacheModels = lemonadeDir ? scanModels(lemonadeDir) : [];
  const peerConfigs = config.peers.map((p) => ({
    ...p,
    isLocal: p === localPeer,
  }));
  return (
    <LemonadeModal
      activeLocation={location}
      coldModels={coldModels}
      localModelsPath={localModelsDir ?? ''}
      hfTokenSet={!!process.env.HF_TOKEN}
      peerConfigs={peerConfigs}
      localPeerAddress={localPeer?.address ?? null}
      localPeerModels={localModels}
      lemonadeCacheModels={lemonadeCacheModels}
    />
  );
}
```

- [ ] **Step 3: Verify**

Run: `bun typecheck && bun lint`
Expected: pass (components are not yet referenced by any route — that's Task 4).

- [ ] **Step 4: Commit**

```bash
jj commit -m "Add the LemonadeModal dialog and its server route component"
```

---

### Task 4: Wire the intercepted and hard-nav routes; retire `LemonadeClient`

**Files:**
- Create: `app/(chrome)/download/lemonade/page.tsx`
- Create: `app/(chrome)/[location]/download/lemonade/page.tsx`
- Create: `app/(chrome)/@modal/(.)download/lemonade/page.tsx`
- Create: `app/(chrome)/@modal/(.)[location]/download/lemonade/page.tsx`
- Modify: `app/(chrome)/[[...location]]/page.tsx` (drop the `lemonade` branch)
- Delete: `components/lemonade/lemonade-client.tsx`

**Interfaces:**
- Consumes: `HomeView` (Task 1), `LemonadeModalRoute` (Task 3), existing `resolveLocation`/`ALL_LOCATION`/`COLD_STORAGE_LOCATION` from `@/lib/locations`.
- Produces: the final URL behavior; nothing downstream.

**Risk check (spec risks 1–2), before committing:** `[location]/` must coexist with `[[...location]]/` as siblings, and `/download/hf` must still backtrack past the static `download/` folder to the catch-all. Step 6 verifies both; if Next rejects the structure at dev/build time, stop and fall back per the spec (dissolve the catch-all into explicit `page.tsx`, `[location]/page.tsx`, `download/hf/page.tsx`, `[location]/download/hf/page.tsx` using the same `resolveLocation` validation) — raise this with your human partner before proceeding.

- [ ] **Step 1: Create `app/(chrome)/download/lemonade/page.tsx`**

```tsx
import type {Metadata} from 'next';
import {localPeer} from '@/lib/config';
import {ALL_LOCATION} from '@/lib/locations';
import {HomeView} from '@/components/home/home-view';
import {LemonadeModalRoute} from '@/components/lemonade/lemonade-modal-route';

export function generateMetadata(): Metadata {
  return {title: `Turbo Jumbo - ${localPeer?.name ?? 'unknown'}`};
}

// Hard navigation (refresh/deep link) to /download/lemonade: render the All
// table with the download modal already open. Soft navigation from within the
// app is intercepted into the @modal slot instead and never reaches this page.
export const dynamic = 'force-dynamic';

export default function LemonadeDownloadPage() {
  return (
    <>
      <HomeView location={ALL_LOCATION} />
      <LemonadeModalRoute location={ALL_LOCATION} />
    </>
  );
}
```

- [ ] **Step 2: Create `app/(chrome)/[location]/download/lemonade/page.tsx`**

```tsx
import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {config, localPeer} from '@/lib/config';
import {resolveLocation, COLD_STORAGE_LOCATION} from '@/lib/locations';
import {HomeView} from '@/components/home/home-view';
import {LemonadeModalRoute} from '@/components/lemonade/lemonade-modal-route';

export function generateMetadata(): Metadata {
  return {title: `Turbo Jumbo - ${localPeer?.name ?? 'unknown'}`};
}

// Hard navigation (refresh/deep link) to /<peer>/download/lemonade: render
// that peer's table with the download modal already open.
export const dynamic = 'force-dynamic';

export default async function PeerLemonadeDownloadPage({
  params,
}: {
  params: Promise<{location: string}>;
}) {
  const {location: slug} = await params;
  const location = resolveLocation([slug], config.peers);
  // Cold Storage has no Lemonade view; unknown slugs 404 (parity with the
  // old parseRoute behavior).
  if (location === null || location === COLD_STORAGE_LOCATION) notFound();
  return (
    <>
      <HomeView location={location} />
      <LemonadeModalRoute location={location} />
    </>
  );
}
```

- [ ] **Step 3: Create the interceptors in the `@modal` slot**

`app/(chrome)/@modal/(.)download/lemonade/page.tsx`:

```tsx
import {ALL_LOCATION} from '@/lib/locations';
import {LemonadeModalRoute} from '@/components/lemonade/lemonade-modal-route';

// Soft navigation to /download/lemonade: fill the @modal slot with the
// download modal over whatever page is currently rendered.
export const dynamic = 'force-dynamic';

export default function InterceptedLemonadePage() {
  return <LemonadeModalRoute location={ALL_LOCATION} />;
}
```

`app/(chrome)/@modal/(.)[location]/download/lemonade/page.tsx`:

```tsx
import {config} from '@/lib/config';
import {resolveLocation, COLD_STORAGE_LOCATION} from '@/lib/locations';
import {LemonadeModalRoute} from '@/components/lemonade/lemonade-modal-route';

// Soft navigation to /<peer>/download/lemonade. Invalid locations render no
// modal — the app never links to them, and a hard navigation 404s on the
// real route instead.
export const dynamic = 'force-dynamic';

export default async function InterceptedPeerLemonadePage({
  params,
}: {
  params: Promise<{location: string}>;
}) {
  const {location: slug} = await params;
  const location = resolveLocation([slug], config.peers);
  if (location === null || location === COLD_STORAGE_LOCATION) return null;
  return <LemonadeModalRoute location={location} />;
}
```

- [ ] **Step 4: Drop the `lemonade` branch from the catch-all page**

In `app/(chrome)/[[...location]]/page.tsx`: delete the whole `if (view === 'lemonade') { … }` block and the now-unused imports (`scanModels`, `coldStorageDir`, `lemonadeDir`, `LemonadeClient`). `parseRoute` stays — it still recognizes `lemonade` paths for `AppChrome`'s active-location derivation, but the explicit routes above now own those URLs, so this page never receives them.

- [ ] **Step 5: Delete `components/lemonade/lemonade-client.tsx`**

```bash
rm components/lemonade/lemonade-client.tsx
grep -rn "lemonade-client" app components lib
```

Expected: no matches.

- [ ] **Step 6: Verify the URL matrix (risk check)**

Run: `bun typecheck && bun lint && bun test`, then `bun dev` (watch its output for route-conflict errors) and check hard-nav status codes, with `<peer>` = a peer slug from your `config.yaml`:

| URL | Expected |
|---|---|
| `/`, `/<peer>`, `/cold-storage` | 200, table |
| `/download/hf`, `/<peer>/download/hf` | 200, HF page (risk 2: backtracks past `download/`) |
| `/download/lemonade`, `/<peer>/download/lemonade` | 200, table + open modal (risk 1: `[location]` beside `[[...location]]`) |
| `/cold-storage/download/lemonade`, `/foo/download/lemonade` | 404 |
| `/foo/bar` | 404 |

Then in a browser: Add model → From Lemonade opens the modal over the table (URL updates, table stays mounted); close returns to the table URL and Back does not reopen the modal; browser Back while open closes it; refresh on the modal URL shows table + open modal; starting a download stacks the progress dialog above the modal and markers refresh after it finishes.

- [ ] **Step 7: Commit**

```bash
jj commit -m "Route the Lemonade downloader through an intercepted modal"
```

---

### Task 5: Final verification

- [ ] **Step 1: Full checks and production build**

Run: `bun typecheck && bun lint && bun test && bun build`
Expected: all pass; the build lists the new `(chrome)` routes (including `@modal` entries) with no conflicts.

- [ ] **Step 2: Commit any straggler fixes**

Only if Step 1 required changes:

```bash
jj commit -m "Fix build fallout from the Lemonade modal routes"
```
