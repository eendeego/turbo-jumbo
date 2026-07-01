# Move the Hugging Face download UI to a `/<peer>/download/hf` route

## Goal

Today the Hugging Face download UI is a button-launched modal. In the Turbo
Jumbo table view, an **"Add from Hugging Face…"** button opens a `Dialog`
(`components/hf-download/hugging-face-download.tsx`) containing a URL input,
a file picker, copy-to-cold options, and a Copy/Run footer; clicking **Run**
swaps the picker for a progress terminal (`DownloadModal`).

Move that picker to a real nested route so it has its own URL, mirroring the
Lemonade route (`/<peer>/download/lemonade`):

- All → `/download/hf`
- Local peer → `/<slug>/download/hf`

The **"Add from Hugging Face"** button becomes a link to the route; the picker
renders inline on the page instead of as a dialog.

## Scope

The route exists only where the button shows today — where downloads run
locally: the **All** view and the **local peer**. Cold Storage and remote peers
have no Hugging Face download route (those `…/download/hf` paths 404).

Out of scope: changing the download mechanics (`useDownloadRunner`, the API
routes) or the Lemonade route.

## Approach

Same pattern as the Lemonade route. Keep the single optional catch-all
(`app/[[...location]]/page.tsx`). Extend `parseRoute` to recognize a trailing
`download/hf`, branch the page to a new `HfDownloadClient`, and decompose the
existing `HuggingFaceDownload` so its picker can render inline on the page.

## Changes

### 1. Routing — `lib/locations.ts`

Widen the view union and extend the parser:

```ts
export type RouteView = 'table' | 'lemonade' | 'hf';
```

`parseRoute` gains a `download/hf` case alongside `download/lemonade`. The HF
view is allowed only for the All view or the local peer:

- `['download','hf']` → `{location: all, view: 'hf'}`
- `['<local-slug>','download','hf']` → `{location: <local addr>, view: 'hf'}`
- `['<remote-slug>','download','hf']` → `null`
- `['cold-storage','download','hf']` → `null`

Implementation: detect a trailing `['download','hf']`, resolve the 0–1 head
segments via `resolveLocation`, then accept only when the resolved location is
`ALL_LOCATION` or a peer whose `isLocal` is true; otherwise `null`.

Add `hfHref(id, peers)`:

- `ALL_LOCATION` → `/download/hf`
- a peer → `/<slug>/download/hf`
- `COLD_STORAGE_LOCATION` → not expected; fall back to `/cold-storage`.

### 2. Page entry — `app/[[...location]]/page.tsx`

Add a `view === 'hf'` branch before the table branch, rendering
`<HfDownloadClient .../>` with the same prop shape as `LemonadeClient`. Only
`localModelsPath`, `hfTokenSet`, `logLevel`, `activeLocation`, `peerConfigs`
are actually consumed.

### 3. Extract the inline picker — `components/hf-download/hf-download-picker.tsx`

Move the picker out of `HuggingFaceDownload` into a component that renders
inline (no `Dialog`). It owns all the picker state and behavior currently in
`hugging-face-download.tsx`:

- `url` + 400ms `debouncedUrl`, `parseHfUrl` parsing, `isInvalid`
- the file-list fetch effect (`/api/v1/hf-files`), `files`/`filesLoading`/
  `filesError`, `selectedPaths` seeded by `defaultDownloadSelection`, `filter`
- `selectedFiles`, `totalSize`, `visibleFiles`, `command` (`buildHfCommand`),
  `toggleFile`, `handleCopy` (`copyToClipboard`), `sendToCold`,
  `deleteAfterTransfer`
- `useDownloadRunner(localModelsPath)` and `startDownload`/`closeTerminal`,
  `showTerminal`
- the `DownloadModal` overlay (rendered when `showTerminal`) — stays a modal

Props:

```ts
function HfDownloadPicker(props: {
  localModelsPath: string;
  hfTokenSet: boolean;
  onClose: () => void; // return to the location's table
}): JSX.Element;
```

Rendering: the former dialog body (URL input, loading/error text, filter row,
file list, cold-storage options) and the former dialog footer (selected
count + Copy command + Run), laid out inline. A header row shows the title
(`parsed ? "Download from <repoId>" : "Add from Hugging Face"`) with a
Cancel/Back button wired to `onClose` (replacing the dialog's close affordance).
The fixed `55vh` body height from the dialog is no longer required; the list
scrolls within the page.

### 4. New `components/hf-download/hf-download-client.tsx`

Page wrapper mirroring `LemonadeClient`'s chrome:

- `AppShell` + `Heading` "Turbo Jumbo"
- `LocationTabs` (active = `activeLocation`); `onLocationChange` →
  `router.push(locationHref(id, peerConfigs))` (a switched location shows its
  table; HF isn't available outside All/local)
- `ModelKindTabs` value `"turbo-jumbo"`; `onChange` →
  `lemonadeHref` for `'lemonade'`, else `locationHref` (back to table)
- `<HfDownloadPicker localModelsPath hfTokenSet onClose={() =>
router.push(locationHref(activeLocation, peerConfigs))} />`
- `<Log logLevel={logLevel} />`

No inventory hook needed.

### 5. `HomeClient` — button becomes a link

In `components/home/home-client.tsx`:

- Remove the `HuggingFaceDownload` import and its render in the table body.
- Add `hfHref` to the `@/lib/locations` import.
- Where the component was, render a navigation button:

```tsx
{
  canDownloadLocally && (
    <Button
      label="Add from Hugging Face"
      variant="secondary"
      onClick={() => router.push(hfHref(activeLocation, peerConfigs))}
    />
  );
}
```

The label drops the trailing `…`: per the project convention, the ellipsis
marks buttons that open a dialog, and this now navigates.

Delete `components/hf-download/hugging-face-download.tsx` — its picker logic
now lives in `hf-download-picker.tsx`, and its trigger button is replaced by
the link above.

### 6. Testing — `lib/locations.test.ts`

Add cases:

- `parseRoute(['download','hf'])` → `{all, 'hf'}`
- `parseRoute([localSlug,'download','hf'])` → `{localAddr, 'hf'}`
- `parseRoute([remoteSlug,'download','hf'])` → `null`
- `parseRoute(['cold-storage','download','hf'])` → `null`
- `parseRoute(['download','hf','extra'])` → `null`
- `hfHref('all', peers)` → `/download/hf`; `hfHref(localAddr, peers)` →
  `/<localSlug>/download/hf`
- round-trip `hfHref` → `parseRoute` for the local peer.

## Verification

- `bun typecheck`, `bun lint`, `bun test` (new + existing pass).
- Manual: from `/` and the local peer table, the **Add from Hugging Face**
  button navigates to `/download/hf` / `/<slug>/download/hf`; the picker renders
  inline; URL entry fetches files; Run opens the terminal modal; Back returns to
  the table. `/<remote-slug>/download/hf` and `/cold-storage/download/hf` 404.
  Switching a LocationTab on the HF page lands on that location's table.
