# Hugging Face Download Route Implementation Plan

**Goal:** Move the Hugging Face download picker from a button-launched modal
into a nested route `/<peer>/download/hf` (and `/download/hf` for All), with
the trigger button becoming a link.

**Architecture:** Reuse the Lemonade-route pattern. Extend `parseRoute`/add
`hfHref` in `lib/locations.ts`, branch the catch-all page to a new
`HfDownloadClient`, and extract the picker out of `HuggingFaceDownload` into
an inline `HfDownloadPicker`. The progress terminal stays a modal overlay.

Spec: `docs/specs/2026-06-19-hf-download-route-design.md`

**Scope constraint:** the HF route exists only where the button shows today —
the All view and the local peer (downloads run locally). Remote-peer and
cold-storage `…/download/hf` paths must 404.

## Task 1: Routing helpers for the `hf` view (`lib/locations.ts`)

Widen `RouteView` to `'table' | 'lemonade' | 'hf'`. `parseRoute` gains a
`download/hf` case alongside `download/lemonade`: detect a trailing
`['download', 'hf']`, resolve the 0–1 head segments via `resolveLocation`,
then accept only when the resolved location is `ALL_LOCATION` or a peer whose
`isLocal` is true — otherwise null (remote peers and cold storage have no HF
route).

Add `hfHref(id, peers)`: `ALL_LOCATION` → `/download/hf`; a peer →
`/<slug>/download/hf`; `COLD_STORAGE_LOCATION` falls back to `/cold-storage`.

Tests (`lib/locations.test.ts`): `download/hf` → all/hf; local-peer-slug →
local peer/hf; remote-peer-slug → null; cold-storage → null; a malformed
trailing shape → null; `hfHref` for all and the local peer; a round-trip
`hfHref` → `parseRoute` for the local peer.

## Task 2: Inline `HfDownloadPicker`

New `components/hf-download/hf-download-picker.tsx` — the picker extracted
from `hugging-face-download.tsx` minus the trigger button and the dialog
wrapper, rendered inline with a header (title + a "Back" button wired to
`onClose`) instead of a dialog close affordance. Owns the same state and
behavior as today: URL input + debounce + `parseHfUrl`, the file-list fetch
against `/api/v1/hf-files`, `defaultDownloadSelection`, the filter/file list,
cold-storage options, `buildHfCommand`/copy, and `useDownloadRunner` +
`startDownload`/`closeTerminal` (the progress terminal stays a `DownloadModal`
overlay). Props: `{localModelsPath, hfTokenSet, onClose}`.

## Task 3: `HfDownloadClient` page wrapper

New `components/hf-download/hf-download-client.tsx`, mirroring
`LemonadeClient`'s chrome: `AppShell` + `Heading` "Turbo Jumbo", `LocationTabs`
(switching location goes to that location's table via `locationHref` — HF
isn't available outside All/local), `ModelKindTabs` value `"turbo-jumbo"`
(`onChange` → `lemonadeHref` for `'lemonade'`, else back to the table via
`locationHref`), and `HfDownloadPicker` with `onClose` returning to the
location's table. No inventory hook needed. Props:
`{activeLocation, localModelsPath, hfTokenSet, logLevel, peerConfigs}`.

## Task 4: Wire the route and turn the button into a link

`app/[[...location]]/page.tsx`: add a `view === 'hf'` branch (before the
`'lemonade'` branch) rendering `HfDownloadClient` with
`{activeLocation, localModelsPath, hfTokenSet, logLevel, peerConfigs}`.

`components/home/home-client.tsx`: replace the `HuggingFaceDownload`
component render (gated on `canDownloadLocally`) with a `Button` labeled
**"Add from Hugging Face"** (no trailing ellipsis — it navigates, not opens a
dialog) that does `router.push(hfHref(activeLocation, peerConfigs))`. Drop
the `HuggingFaceDownload` import.

Delete `components/hf-download/hugging-face-download.tsx` — its picker logic
now lives in `hf-download-picker.tsx`, and its trigger button is replaced by
the link above.

## Verification

- `bun typecheck`, `bun lint`, `bun test` (new + existing pass), a production
  build.
- Manual: from `/` and the local peer table, **Add from Hugging Face**
  navigates to `/download/hf` / `/<slug>/download/hf`; the picker renders
  inline; URL entry fetches files; Run opens the terminal modal; Back returns
  to the table. A remote peer's and Cold Storage's `…/download/hf` 404.
  Switching a LocationTab on the HF page lands on that location's table.
