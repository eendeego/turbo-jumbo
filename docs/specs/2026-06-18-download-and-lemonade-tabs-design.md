# Download cleanup + Turbo Jumbo / Lemonade tabs

## Overview

Reorganize a peer page into two sub-tabs — **Turbo Jumbo** and **Lemonade** —
and clean up the two download surfaces so they're consistent. Today the
`HuggingFaceDownload` box (a persistent URL field) sits atop every non–cold-storage
tab and carries a "Browse Lemonade models…" button that opens the `LemonadeBrowser`
modal. After this change, HF download is an "Add from Hugging Face…" dialog inside
the Turbo Jumbo sub-tab, and the Lemonade catalog becomes the inline content of the
Lemonade sub-tab (the modal goes away).

## Navigation (decided via mockups)

- **Location tabs stay the top row:** `All | <peers…> (local) | Cold Storage`.
- **Sub-tabs appear on every tab except Cold Storage:** `❲ Turbo Jumbo ❳  Lemonade`
  — on each peer (incl. local) **and on the All tab**, so Lemonade can be
  browsed/downloaded from the overview too. The All tab's Turbo Jumbo sub-tab is
  the existing cross-peer table; its Lemonade sub-tab is the catalog with
  Download enabled (targets local). **Cold Storage** stays a single view (no
  sub-tabs).
- Sub-tab selection is component state (not in the URL). Switching location
  resets to the Turbo Jumbo sub-tab.

## Download targeting (important constraint)

HF and Lemonade downloads run only on the **local machine** (`localModelsDir`);
there is no remote-peer download path. So download **actions are local-only**:

- **Local peer tab:** Turbo Jumbo = models table **+ "Add from Hugging Face…"**;
  Lemonade = catalog **+ Download**.
- **Remote peer tab:** browse-only. Turbo Jumbo = the peer's models table (no Add
  button); Lemonade = the catalog with that peer's per-model status, **Download
  disabled** with a hint ("download on <local>, then copy"). This corrects
  today's quirk where the download box appears on remote tabs but silently
  targets the local machine.
- **All tab:** has the sub-tabs. Turbo Jumbo keeps the **"Add from Hugging Face…"**
  button (targets local); Lemonade is the catalog with Download enabled (targets
  local).
- **Cold Storage tab:** no download affordance (unchanged — the download box is
  already hidden there).

## Turbo Jumbo sub-tab

- The existing models table for the location (unchanged).
- A toolbar **"Add from Hugging Face…"** button (on the local peer's Turbo Jumbo
  sub-tab and on the All tab) opening a dialog that holds the URL field **and**
  the file picker. Today the URL field is a persistent box and the picker is a
  separate dialog that opens once a URL parses; these merge into one dialog:
  type/paste a repo or URL at the top, the file list + filter + "copy to cold
  storage / delete after" options + footer ("Copy command" / "Run") appear below.
- `HuggingFaceDownload` is refactored from an always-on section into this
  button-triggered dialog. Its "Browse Lemonade models…" button is **removed**
  (Lemonade now has its own sub-tab).

## Lemonade sub-tab

- The current `LemonadeBrowser` catalog, **inlined** as the sub-tab body instead
  of a `Dialog` modal: the filter, the model/collection/component list with
  capability icons and present/partial status markers, and a footer
  (selection summary + "copy to cold storage" option + **Download**).
- Status markers reflect the **current location** (the peer whose tab is open),
  via the existing `inventoryLocations` data.
- Download targets the local machine and is enabled only on the local tab (see
  above); it reuses the same download runner and progress view as HF.

## Shared download mechanics (the uniformization)

Both surfaces already share `useDownloadRunner` + the download-progress modal
(the progress terminal) and the "copy to cold storage when done / delete after
transfer" options. This work makes that explicit and consistent: identical
option controls, identical progress modal, identical button styling/labels
across the HF dialog and the Lemonade footer. No change to the download API
routes.

## Components

- `components/home/home-client.tsx` — add sub-tab state for peer/local pages;
  render the `❲ Turbo Jumbo ❳ Lemonade` switch; route content to the Turbo
  Jumbo view (table + Add dialog) or the Lemonade view (inline catalog). All /
  Cold Storage render as today.
- New `components/models/model-kind-tabs.tsx` — the small
  `Turbo Jumbo | Lemonade` tab switch (mirrors `components/models/location-tabs.tsx`).
- `components/hf-download/hugging-face-download.tsx` — refactor to a button +
  single dialog (URL field merged into the picker dialog); drop the Lemonade
  button; accept an `enabled`/`canDownload` flag so it's add-capable only on the
  local tab.
- `components/lemonade/lemonade-browser.tsx` — drop the `Dialog` wrapper; export
  the catalog as inline content with a `canDownload` flag; remove `onClose`.
- `components/models/location-tabs.tsx`, `components/hf-download/download-runner.tsx`
  — unchanged.

## Testing

The touched components import Astryx components, so they aren't unit-rendered
(matching the repo's existing coverage). Extract any newly-needed pure logic
into `lib/` with `bun test` coverage; otherwise verify via `bun typecheck` +
`bun lint` and a manual pass in the running app (sub-tab switching, Add dialog
on local vs remote, Lemonade catalog inline, download progress, cold-storage
option).

## Out of scope

- Remote-peer downloads (no backend path exists; would be its own project).
- The Peers column redesign and any other "All" tab changes (separate cycle).
- Changes to the download API routes or the Lemonade catalog data.
