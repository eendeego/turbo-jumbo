# Persistent AppShell via a Next.js layout

Date: 2026-06-25
Status: Approved

## Goal

When a user opens **Add model → From Hugging Face** or **Add model → From Lemonade**, the
AppShell (TopNav, location tabs, app chrome) must stay mounted; only the content area
changes. Today each `view` renders a separate client component that builds its own
AppShell, so navigating remounts the whole shell (a visual flash and lost shell state).

## Current state

- Routing is a single catch-all: `app/[[...location]]/page.tsx`. It parses the path with
  `parseRoute(...)` into `{ location, view }`, where `view` is `table | hf | lemonade`.
- The page renders one of three client components by `view`:
  - `table` → `HomeClient` (new TopNav shell: heading + centered `LocationTabs` + endContent
    Consolidate/Add model/theme toggle; `Layout` with the table in `content` and the action
    bar/console in `footer`).
  - `hf` → `HfDownloadClient` (old shell: `AppShell` + `<Heading>Turbo Jumbo</Heading>` + raw
    `div` spacers + `LocationTabs` + `HfDownloadPicker`).
  - `lemonade` → `LemonadeClient` (old shell, plus an "Add from Lemonade" heading, a catalog
    note, and a Back button + `LemonadeBrowser`).
- Each of the three renders its **own** `<AppShell>` and its **own** `<Log>`. The URLs already
  exist (`/download/hf`, `/<peer>/download/hf`, `/download/lemonade`, …) via `hfHref`/`lemonadeHref`.
- `AddModelMenu` (in the TopNav) `router.push`es to those routes.

The routes are fine; the problem is purely that the shell is rebuilt per view.

## Design

### Route structure (URLs unchanged)

Split the catch-all into a persistent **layout** + a swappable **page**:

- `app/[[...location]]/layout.tsx` (server) — reads `config`, parses the route, renders the
  shared shell (`AppChrome`) wrapping `{children}`.
- `app/[[...location]]/page.tsx` (server) — parses the route, fetches view-specific data,
  renders only the content client for the current `view`.

Both `/` and `/download/hf` resolve to the same `[[...location]]` segment, so Next.js keeps the
layout — and the `AppShell` client inside it — mounted across navigation. Only the page swaps.

### `AppChrome` (new client component, used by the layout)

Owns the persistent shell and the global console.

- Renders `<AppShell contentPadding={0} topNav={<TopNav …/>}>{children}</AppShell>`.
  - TopNav: "Turbo Jumbo" heading + `NavIcon` logo; `centerContent` = `LocationTabs`;
    `endContent` = Consolidate (All/local) + `AddModelMenu` (All/local) + `ThemeToggle`.
  - `LocationTabs.onLocationChange` → `router.push(locationHref(id, peers))` (always returns to
    that location's table — current behavior on every view).
- Holds the **global console state** (`consoleOpen`) and a stable `toggleConsole`.
  - Renders the single `<Log open={consoleOpen} onToggle={toggleConsole} />` overlay here, so it
    persists across navigation (log history + open state carry over).
  - Provides `ConsoleContext` (`{ open, toggle }`) so the table's action-bar button can drive
    the same state. The `~` key handler lives inside the always-mounted `Log`, so it works on
    every view even where no button is shown.
- Owns the Consolidate flow: holds `syncOpen`, renders `LemonadeSyncModal`; `onSynced` calls
  `router.refresh()` (re-renders the server page → refreshes table data) instead of HomeClient's
  local refreshers.
- Props from the layout: `peers`, `activeLocation`, `localPeerAddress`, `canDownloadLocally`,
  `logLevel`, `hfTokenSet`.

### Page content (swappable)

`page.tsx` fetches per-view data and renders a content-only client into the shell:

- `table` → `HomeClient` **minus** AppShell/TopNav/LocationTabs/Log. It renders its
  `Layout` (`content` = the models table in `LayoutContent.tj-models-pane`; `footer` =
  status lines + `ActionBar`) plus its modals. It reads `ConsoleContext` and passes
  `consoleOpen`/`onToggleConsole` to `ActionBar`.
- `hf` → `HfDownloadClient` reduced to the `HfDownloadPicker` in a padded/scrollable container
  (no AppShell, no LocationTabs, no Log).
- `lemonade` → `LemonadeClient` reduced to the "Add from Lemonade" heading + catalog note +
  Back button + `LemonadeBrowser` in a padded/scrollable container.

`contentPadding={0}` on the shared AppShell means HF/Lemonade content wraps itself with padding
(the table view already manages its own via `Layout`).

### `Log` simplification

`Log` reverts to **controlled-only** (`{ logLevel, open, onToggle }`); the green-bar/uncontrolled
fallback added earlier is removed, since the console is now a single global instance rather than
per-view. Entries continue to come from the module-level `client-log` store.

## Data flow

- Layout (server): `params` → `parseRoute` → `activeLocation`; `config.peers`,
  `localPeerAddress`, `canDownloadLocally = activeLocation === 'all' || === localPeerAddress`.
  Passes these to `AppChrome` (client).
- Page (server): `params` → `parseRoute` → `{ location, view }`; fetches the same per-view data it
  fetches today; renders the matching content client.
- Console: `AppChrome` state → `ConsoleContext` + `<Log>`. `HomeClient` consumes the context and
  forwards to `ActionBar`. `~` toggles via `Log`.
- Location switch: `AppChrome` `router.push`. The page re-renders with new `activeLocation`;
  `HomeClient`'s existing `useEffect` keyed on `modelsTableData` resets selection/audit.

## Edge cases & decisions

- **Invalid route**: `page.tsx` keeps calling `notFound()`. The layout must tolerate a `null`
  route (render the shell with a safe default / omit tabs) so the not-found content renders inside
  the shell.
- **Sticky-table scroll**: unchanged. AppShell still wraps children in its internal
  Layout/LayoutContent; the table page still nests its own `Layout` + `.tj-models-pane`, so the
  `.tj-models-pane .astryx-table-scroll-wrapper { height:100% }` rule still applies.
- **Layout re-render on param change**: tabs' active state comes from the route. If the layout
  does not re-render on a param-only change, derive active state client-side from `usePathname()`
  in `AppChrome`. Verify during implementation.
- **Console overlay bottom padding**: the 72px bottom pad clears the action bar on the table view;
  on HF/Lemonade (no action bar) it's a harmless gap. Acceptable; revisit only if it looks off.

## Out of scope

- No URL changes. No change to `parseRoute`/`hfHref`/`lemonadeHref`.
- No redesign of the table, picker, or browser internals beyond removing their shell wrappers.
- HF/Lemonade keep their existing Back affordance; tabs also return to a table.

## Verification

- `bun typecheck`, `bun run build`, `bun lint` clean.
- Manual (or SSR-DOM) check: from `/`, open Add model → From Hugging Face and → From Lemonade; the
  TopNav/heading/tabs stay mounted (no flash), only the content swaps; the active tab tracks the
  location; `~` opens the console on every view and the table's action-bar icon still toggles it;
  switching location tabs from any view lands on that location's table.
