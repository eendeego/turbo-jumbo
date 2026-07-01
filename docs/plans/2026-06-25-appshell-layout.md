# Persistent AppShell via a Next.js layout — Implementation Plan

**Goal:** Move the AppShell/TopNav into `app/[[...location]]/layout.tsx` so opening
Add model → HF/Lemonade swaps only the content, with one global console living
in the layout.

**Architecture:** A server `layout.tsx` parses the route and renders a new
`AppChrome` client (AppShell + TopNav + global console + Consolidate). The
catch-all `page.tsx` renders content-only clients per `view`. Because `/` and
`/download/hf` share the `[[...location]]` segment, Next.js keeps the layout
(and AppShell) mounted across navigation.

**Tech Stack:** Next.js 16 App Router, React, TypeScript (strict), Astryx
(`@astryxdesign/core`), Bun, jj.

**Spec:** `docs/specs/2026-06-25-appshell-layout-design.md`

---

## Global Constraints

- Package manager: **bun**. VCS: **jj** (not git). No `Co-Authored-By` trailer.
- No `<div>` for layout in Astryx-pure components; Astryx `Stack`/`Layout`
  components do the layout work. `app/globals.css`'s
  `.tj-models-pane .astryx-table-scroll-wrapper { height:100% }` rule must
  keep matching.
- Per-task verification: `bun typecheck` (no errors), `bun run build`
  ("Compiled successfully"), `bun lint` (no new errors), `bun test` (all
  passing). Format changed files with `bunx prettier --write <files>`.
- Commit after each task with `jj commit -m "..."`.
- URLs and `lib/locations.ts` (`parseRoute`/`hfHref`/`lemonadeHref`) are
  unchanged.

---

## File Structure

| File                                            | Action | Responsibility                                               |
| ----------------------------------------------- | ------ | ------------------------------------------------------------ |
| `components/chrome/console-context.tsx`         | Create | `ConsoleContext`/`useConsole()` — global console open/toggle |
| `components/chrome/app-chrome.tsx`              | Create | Persistent AppShell/TopNav/console/Consolidate shell         |
| `app/[[...location]]/layout.tsx`                | Create | Parses the route, renders `AppChrome` wrapping `{children}`  |
| `app/[[...location]]/page.tsx`                  | Modify | Content-only per view (drops AppShell/TopNav/Log wrapping)   |
| `components/home/home-client.tsx`               | Modify | Content-only: table `Layout` + footer, reads `useConsole()`  |
| `components/hf-download/hf-download-client.tsx` | Modify | Content-only: just the picker in a padded container          |
| `components/lemonade/lemonade-client.tsx`       | Modify | Content-only: heading/catalog note/Back/browser, no shell    |
| `components/log/log.tsx`                        | Modify | Revert to controlled-only (`open`/`onToggle` required)       |

---

### Task 1: Console context

**Files:** create `components/chrome/console-context.tsx`.

- A `ConsoleContext` of `{open: boolean; toggle: () => void}`, a
  `ConsoleProvider` (re-exported `Context.Provider`), and a `useConsole()`
  hook that throws when used outside the provider.
- Verify (`bun typecheck`, format, commit): `jj commit -m "Add ConsoleContext for the global console state"`.

### Task 2: AppChrome — the shared shell

**Files:** create `components/chrome/app-chrome.tsx`.

- Client component, props `{peers, activeLocation, canDownloadLocally,
logLevel, hfTokenSet, children}`.
- Renders `<AppShell contentPadding={0} topNav={<TopNav .../>}>{children}</AppShell>`,
  mirroring the TopNav currently built in `home-client.tsx` (heading + `NavIcon`
  logo, `centerContent` = `LocationTabs`, `endContent` = Consolidate button +
  `AddModelMenu` + `ThemeToggle`).
- Holds `consoleOpen` state + `toggleConsole`, wraps `children` in
  `ConsoleProvider`, and renders the single `<Log open={consoleOpen}
onToggle={toggleConsole} />` here so it persists across navigation.
- Owns the Consolidate flow (`syncOpen`, `LemonadeSyncModal`); `onSynced`
  calls `router.refresh()`.
- Written but not yet wired into routing, so the build stays green.
- Verify + commit: `jj commit -m "Add AppChrome: the shared AppShell/TopNav + global console"`.

### Task 3: Layout renders AppChrome; HomeClient becomes content-only

**Files:** create `app/[[...location]]/layout.tsx`; modify `app/[[...location]]/page.tsx`
and `components/home/home-client.tsx`.

- The layout parses the route server-side (same `parseRoute` the page already
  uses), computes `canDownloadLocally`, and renders `<AppChrome
peers={...} activeLocation={...} ...>{children}</AppChrome>`.
- The page drops its own `AppShell`/`TopNav`/`Log` wrapping for the `table`
  view; `HomeClient` renders only its `Layout` (table `content` + status/
  `ActionBar` `footer`) and modals, reading `useConsole()` for the action
  bar's `consoleOpen`/`onToggleConsole` instead of owning that state itself.
- Verify + commit: `jj commit -m "Render the shell from a layout; make HomeClient content-only"`.

### Task 4: HfDownloadClient content-only

**Files:** modify `components/hf-download/hf-download-client.tsx`.

- Drop its own `AppShell`/heading/`LocationTabs`/`Log`; render just the
  `HfDownloadPicker` in a padded/scrollable container (the shell now comes
  from the layout).
- Verify + commit: `jj commit -m "Make HfDownloadClient content-only (shell comes from the layout)"`.

### Task 5: LemonadeClient content-only

**Files:** modify `components/lemonade/lemonade-client.tsx`.

- Drop its own `AppShell`/heading/`LocationTabs`/`Log`; keep the "Add from
  Lemonade" heading, the catalog-source note, the Back button, and
  `LemonadeBrowser`, in a padded/scrollable container.
- Verify + commit: `jj commit -m "Make LemonadeClient content-only (shell comes from the layout)"`.

### Task 6: Simplify Log to controlled-only

**Files:** modify `components/log/log.tsx`.

- Remove the uncontrolled/green-bar fallback added for the per-view console;
  `open`/`onToggle` become required props since `AppChrome` is now the single
  mount point.
- Verify + commit: `jj commit -m "Simplify Log to controlled-only (console is global now)"`.

### Task 7: Final verification

- `bun typecheck`, `bun run build`, `bun lint`, `bun test` all clean.
- Manual/SSR-DOM check: from `/`, open Add model → From Hugging Face and →
  From Lemonade; the TopNav/heading/tabs stay mounted (no flash), only the
  content swaps; the active tab tracks the location; `~` opens the console on
  every view and the table's action-bar icon still toggles it; switching
  location tabs from any view lands on that location's table.

## Self-Review

- No URL changes; `parseRoute`/`hfHref`/`lemonadeHref` untouched.
- No redesign of the table, picker, or browser internals beyond removing
  their shell wrappers.
- HF/Lemonade keep their existing Back affordance; tabs also return to a
  table.
