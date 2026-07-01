# Download + Turbo Jumbo / Lemonade Tabs Implementation Plan

**Goal:** Give peer/local pages `Turbo Jumbo | Lemonade` sub-tabs, inline the
Lemonade catalog (no modal), turn HF download into an "Add from Hugging
Face…" button→dialog, and make download actions local-only.

**Architecture:** A small `ModelKindTabs` control plus sub-tab state in
`home-client` routes peer/local pages to either the Turbo Jumbo view (models
table + HF Add) or the inline Lemonade catalog. `HuggingFaceDownload` becomes
a button-triggered dialog (URL field merged into the picker); `LemonadeBrowser`
loses its `Dialog` wrapper and gains a `canDownload` flag. The HF URL parser is
extracted to `lib/` and unit-tested; component changes are verified by
typecheck/lint + a manual pass.

**Tech Stack:** Next.js, React, Astryx components, bun test.

**Spec:** `docs/specs/2026-06-18-download-and-lemonade-tabs-design.md`

## Task 1: Extract the HF URL parser to `lib/hf-url.ts` (with tests)

Pure logic currently buried in `hugging-face-download.tsx`. Extracting it
both cleans up the component and gives us something TDD-able.

`parseHfUrl(url): ParsedUrl | null` where
`ParsedUrl = {repoId, branch, folder, filename}` — parses a bare `org/repo`,
a repo URL, a `blob`/`tree` branch URL, and a `blob`/`resolve` file URL (with
optional subfolder); returns null for anything else.

Move the type and function verbatim out of
`components/hf-download/hugging-face-download.tsx` into the new `lib/hf-url.ts`,
and import it back in.

Tests (`lib/hf-url.test.ts`): bare org/repo; blob file URL with a folder;
tree/branch URL; null for a non-HF string.

## Task 2: `ModelKindTabs` control

New `components/models/model-kind-tabs.tsx`, mirroring
`components/models/location-tabs.tsx`: a small `Turbo Jumbo | Lemonade` tab
switch, `value: ModelKind` (`'turbo-jumbo' | 'lemonade'`), `onChange`.

## Task 3: Inline the Lemonade catalog (drop the modal, add `canDownload`)

`components/lemonade/lemonade-browser.tsx`:

- Props become `{hfTokenSet, inventoryLocations, canDownload}` — drop
  `onClose`.
- The dialog wrapper is replaced with plain inline content: keep the filter
  input + model/collection list, and the footer (selection summary + "copy to
  cold storage" + Download), with no dialog chrome. The download-progress
  modal stays, opened from inline state exactly as before.
- Gate the Download action on `canDownload`: disabled when `!canDownload`,
  with a hint next to it ("Download runs on the local machine — open the
  local tab, then copy.").

## Task 4: HF download becomes a button → dialog

`components/hf-download/hugging-face-download.tsx`:

- Replace the persistent URL box with a single **"Add from Hugging Face…"**
  button that opens a dialog. Move the URL input to the top of the dialog
  body, above the file list; keep the existing debounce → `parseHfUrl` →
  `/api/v1/hf-files` fetch → file list/filter/cold-storage options/footer
  exactly as-is.
- Closing the dialog clears the url state.
- Remove the "Browse Lemonade models…" button and the inline
  `LemonadeBrowser` modal usage (Lemonade now lives in its own sub-tab —
  Task 5). Drop the now-unused `inventoryLocations` prop.

## Task 5: Wire sub-tabs into `home-client`

`components/home/home-client.tsx`:

- Add `modelKind` state (`ModelKind`, default `'turbo-jumbo'`), reset to
  `'turbo-jumbo'` whenever the active location changes.
- Derive `isLocal` (active location is this machine), `isPeerPage` (not
  `all`/`cold-storage`), `showHfAdd` (`all` or local peer — downloads run
  locally only).
- Render `ModelKindTabs` only on peer pages. When on a peer page with
  `modelKind === 'lemonade'`, render the inline `LemonadeBrowser` with
  `canDownload={isLocal}` instead of the models table. Otherwise render the
  existing Turbo Jumbo view: the "Add from Hugging Face…" trigger (only when
  `showHfAdd`) plus the unchanged `ModelsTableClient`.
- `All` and `Cold Storage` locations keep their current single-view
  rendering (no sub-tabs).

## Verification (each task)

- `bun typecheck`, `bun lint` clean.
- `bun test` — all pass (Task 1 adds real coverage; the rest are
  Astryx-component changes verified by typecheck/lint + a manual pass).
- Manual pass in the running app: local peer tab shows sub-tabs with a
  working Add dialog and Lemonade download; remote peer tab shows sub-tabs
  with Add hidden and Lemonade download disabled + hinted; All/Cold Storage
  render as today.
