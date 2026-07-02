# Lemonade downloader as an intercepted-route modal

**Date:** 2026-07-01
**Status:** Approved

## Summary

Move the "Add from Lemonade" downloader from a full page back into a modal
(Astryx `Dialog`) that opens over the models table. Routing uses a Next.js
**intercepted route** with a `@modal` parallel slot: a soft navigation to the
Lemonade URL renders the modal over whatever table is currently shown; a hard
navigation (refresh, deep link) renders the location's table with the modal
already open. No full-page Lemonade view remains.

**URLs do not change**: `/download/lemonade` (All) and
`/<peer-slug>/download/lemonade` (a peer). `lemonadeHref`, `AddModelMenu`, and
`AppChrome`'s pathname parsing keep working as-is. Cold Storage still has no
Lemonade view. The Hugging Face download page is untouched.

## Route structure

Intercepted routes cannot live inside a catch-all, so the Lemonade paths become
explicit route folders beside `[[...location]]`, and the `AppChrome` layout
moves up into a route group that also hosts the `@modal` slot:

```
app/
  layout.tsx                                      (unchanged: html/body/providers)
  (chrome)/
    layout.tsx                                    AppChrome; renders {children} and {modal}
    @modal/
      default.tsx                                 renders null
      (.)download/lemonade/page.tsx               intercepts soft nav to /download/lemonade
      (.)[location]/download/lemonade/page.tsx    intercepts /<peer>/download/lemonade
    [[...location]]/page.tsx                      table + HF views (lemonade branch removed)
    download/lemonade/page.tsx                    hard nav: All table + open modal
    [location]/download/lemonade/page.tsx         hard nav: peer table + open modal
```

- The route group is transparent to URLs and to the interception convention
  (`(.)` counts route segments only, ignoring groups and slots), so
  `(.)download/lemonade` matches `/download/lemonade` and
  `(.)[location]/download/lemonade` matches `/<slug>/download/lemonade`.
- On **soft nav** the interceptor fills the `@modal` slot while the `children`
  slot keeps the previously rendered table mounted underneath.
- On **hard nav** interception does not apply: the slot renders `default.tsx`
  (null) and the real route page renders the location's table plus the modal.
- `app/[[...location]]/layout.tsx` is deleted; its content becomes
  `app/(chrome)/layout.tsx` with a `modal` slot prop rendered after
  `children`.

## Components and data flow

Server components (route composition, shared by pages):

- **`components/home/home-view.tsx`** — async server component
  `HomeView({location})`: the table branch extracted from today's catch-all
  page (scan local + cold models, `getModelsTableData`, render `HomeClient`).
  Used by the catch-all page and both hard-nav Lemonade pages. Moving the scans
  here also stops the HF branch from scanning models it never uses.
- **`components/lemonade/lemonade-modal-route.tsx`** — async server component
  `LemonadeModalRoute({location})`: performs the scans the Lemonade view needs
  (local models, cold models, Lemonade cache models, peer configs, HF-token
  flag) and renders `LemonadeModal`. Used by all four Lemonade route files.

Client component:

- **`components/lemonade/lemonade-modal.tsx`** — replaces
  `components/lemonade/lemonade-client.tsx` (which is deleted). Same state and
  refresh logic (inventory locations, Lemonade cache reseed/refresh,
  incomplete-repo markers, download target/canDownload derivation,
  `onDownloaded` fan-out), but the content renders inside an Astryx `Dialog`:
  - `DialogHeader` titled "Add from Lemonade" with the standard close button
    (replaces the page's "Back" button); the catalog link renders in the body
    above `LemonadeBrowser`.
  - Generous size for the catalog browser: `width` ≈ `min(1100px, 92vw)`,
    `maxHeight` ≈ `85vh`.
  - **Close** (`onOpenChange(false)`): `router.replace(locationHref(activeLocation))`.
    `replace` behaves identically whether the modal was reached by soft or hard
    nav and leaves no modal entry in history (Back after closing does not
    reopen it).
  - **Stale-slot guard:** on soft navigation away (e.g. browser Back while the
    modal is open) Next keeps an unmatched slot's previous state, so the modal
    renders only while `usePathname()` ends with `/download/lemonade`;
    otherwise it renders null.

Route files (all thin, per the app/-is-routing-only convention; all export
`dynamic = 'force-dynamic'`, and the two real pages export the same
`generateMetadata` as the catch-all):

- `@modal/(.)download/lemonade/page.tsx` → `<LemonadeModalRoute location="all" />`
- `@modal/(.)[location]/download/lemonade/page.tsx` → resolve the slug with
  `resolveLocation`; render null for unknown slugs or Cold Storage (the modal
  simply doesn't open — those URLs are never soft-navigated to from the app);
  otherwise `<LemonadeModalRoute location={…} />`
- `download/lemonade/page.tsx` → `<HomeView location="all" />` +
  `<LemonadeModalRoute location="all" />`
- `[location]/download/lemonade/page.tsx` → resolve the slug; `notFound()` for
  unknown slugs or Cold Storage (matches today's `parseRoute` behavior);
  otherwise table + modal as above

`app/(chrome)/[[...location]]/page.tsx` keeps `parseRoute` for the table and
HF branches but drops the `view === 'lemonade'` branch (the explicit routes
now own those URLs). `parseRoute` itself keeps recognizing `lemonade` — 
`AppChrome` uses it to derive the active location from the pathname while the
modal is open.

## Error handling

- Unknown peer slug or Cold Storage under `/…/download/lemonade`: 404 on hard
  nav (real route calls `notFound()`); interceptor renders nothing on soft nav
  (unreachable from app UI).
- The modal's fetch/refresh error handling is unchanged from `LemonadeClient`
  (best-effort refreshes, browser-level error states).

## Risks (verified first during implementation)

1. **`[location]/` sibling of `[[...location]]/`.** Same param name, and no
   competing `page.tsx` at the same depth, so no concrete URL is ambiguous —
   but Next may still reject the combination at build/dev time. Verify by
   scaffolding the routes and hitting the URL matrix before building the modal.
   **Fallback:** dissolve the catch-all into explicit routes (`page.tsx`,
   `[location]/page.tsx`, `download/hf/page.tsx`,
   `[location]/download/hf/page.tsx`) with the same `resolveLocation`
   validation.
2. **`/download/hf` fallback past the static `download/` folder.** With
   `download/lemonade/` present, `/download/hf` must still backtrack to the
   catch-all. Verified in the same URL-matrix check; the fallback above covers
   this too.

## Testing

- `lib/locations.ts` is unchanged, so existing route-parsing tests stand; no
  new lib surface is added (route files and React components follow the repo
  pattern of not having co-located tests).
- `bun typecheck`, `bun lint`, `bun test`, production build.
- Manual URL matrix in `bun dev`: `/`, `/<peer>`, `/cold-storage`,
  `/download/hf`, `/<peer>/download/hf`, `/download/lemonade`,
  `/<peer>/download/lemonade` (soft nav via Add model → From Lemonade, and
  hard refresh on the same URL), `/cold-storage/download/lemonade` → 404,
  `/foo/bar` → 404. Confirm: modal over table on soft nav; table + open modal
  on refresh; close returns to the location table and Back does not reopen;
  browser Back while open closes the modal; downloads still refresh markers.
