# Remote-peer model downloads — design

Date: 2026-06-29
Status: Approved

## Goal

Let a user download Hugging Face **and** Lemonade models onto a **remote
peer** — the download runs on that peer and lands in that peer's storage, not
the local machine. Enable the "Add model" dropdown on remote-peer tabs and
route both download flows to the selected peer.

## Background: current architecture

- Every peer runs the same Next.js app. The local server reaches a remote peer
  over HTTP at `http://${peer.address}/api/v1/...`; the peer routes
  (`peers/[name]/models`, `.../incomplete`, the copy flow) are thin proxies
  that, for the local peer, do the work directly and, for a remote peer,
  `fetch` the peer's own endpoint.
- Downloads POST to `/api/v1/hf-download`, which spawns `hf download` **on the
  machine handling the request** into its local models dir, streams the
  terminal output back, then records sources and (optionally) copies to that
  machine's cold storage. Both the HF picker (`hf-download-picker.tsx`) and the
  Lemonade browser (`lemonade-browser.tsx`) drive it through
  `useDownloadRunner(localModelsPath)` in `download-runner.tsx`.
- `AddModelMenu` is rendered in `app-chrome.tsx` only when `canDownloadLocally`
  (`activeLocation === ALL_LOCATION || activeLocation === localPeerAddress`).
- `parseRoute` (`lib/locations.ts`) allows the **Lemonade** view on any
  non-cold-storage location but restricts the **HF** view to All / local peer.
  Both pickers additionally gate their action button on a `canDownload` notion
  that excludes remote peers.

Because the peer already runs the identical download code, downloading _on_ a
peer needs no new download logic — only a way to route the streaming request to
it and a UI that targets it.

## Approved decisions

1. **Target = active tab.** On a remote peer's tab, "Add model" downloads onto
   that peer. The **All** tab keeps downloading to the local machine. No
   per-download peer picker.
2. **Cold-storage option stays.** "Copy to cold storage when done" remains for
   remote downloads and operates on the **remote peer's own** cold storage
   (the peer runs the same code with its own config).

## Design

### 1. Shared download streamer

Extract the streaming body of `app/api/v1/hf-download/route.ts` `POST` into a
server module `lib/hf-download-stream.ts` exporting
`streamHfDownload(body, signal): Response`. The existing route becomes a thin
caller. This lets the new proxy invoke the exact same implementation for the
local-peer branch without a self-HTTP call. No behavior change for the existing
route.

### 2. Peer download proxy route

New `app/api/v1/peers/[name]/hf-download/route.ts`, `POST`:

- Resolve the peer by `name`; 404 if unknown.
- If the peer is local: delegate to `streamHfDownload(body, req.signal)`.
- If remote: `fetch('http://${peer.address}/api/v1/hf-download', { method:
'POST', headers, body, signal: req.signal })` and return
  `new Response(res.body, { headers: {'Content-Type': 'text/plain; charset=utf-8'} })`,
  piping the stream straight through. On a non-OK upstream response or a thrown
  error, return 502 with the message (the runner renders it as an `Error:` line,
  matching the existing failure path).
- Abort propagates: the client aborts → `req.signal` aborts → the upstream
  `fetch` aborts → the remote route's own `req.signal` SIGTERMs its `hf`
  process (already implemented there).

The client only ever calls this route for a **remote** peer; the local branch
exists for uniformity/robustness.

### 3. Client target resolution

Add a pure helper `lib/download-target.ts`:

```
downloadTarget(activeLocation, peers, localModelsPath)
  -> { url: string; displayPath: string }
```

- All tab or local peer → `{ url: '/api/v1/hf-download', displayPath: localModelsPath }`.
- Remote peer → `{ url: '/api/v1/peers/<name>/hf-download', displayPath: <peer's resolved local-models path> }`.

The remote peer's path is derived from its config the same way the server does
(`base_path` joined with `turbo_jumbo_subdir ?? 'turbo-jumbo'`); if `base_path`
is absent, `displayPath` falls back to a neutral placeholder. `displayPath`
feeds only the copyable `hf` command preview (`buildHfCommand`), which is
cosmetic — the remote peer ultimately uses its own `--local-dir`.

`useDownloadRunner` changes from taking a bare `localModelsPath: string` to
taking a target (`displayPath` + `downloadUrl`): it POSTs to the URL and builds
the command preview from `displayPath`. Each picker computes its target with
`downloadTarget(...)`. `home-client.tsx`'s "Redownload incomplete file" action
operates only on local storage and is unchanged in behavior — it keeps the
local target.

### 4. Gating & routing

- `app-chrome.tsx`: render `AddModelMenu` for **any peer tab or All** (a new
  gate `canAddModel = activeLocation === ALL_LOCATION || peers.some(p =>
p.address === activeLocation)`).
- `lib/locations.ts` `parseRoute`: allow the HF view on remote peers (drop the
  local-only restriction; keep cold-storage excluded). Lemonade already allows
  it. `hfHref` / `lemonadeHref` already build per-location URLs.
- `hf-download-picker.tsx`: accept the resolved target and enable the action
  button for remote-peer tabs.
- `lemonade-browser.tsx`: widen `canDownload` to include remote-peer tabs (All
  still means the local target).

### 5. Lemonade "skip already-downloaded" and status markers

- The "skip files already present" optimization currently reads the **local**
  inventory (`inventoryLocations.find(l => l.isLocal)?.models`). Change it to
  read the **target peer's** inventory (match by the active location's peer
  name; All → local). This keeps the skip correct when the target is a remote
  peer.
- The main download-status marker is already computed across all
  `inventoryLocations`, so it stays correct.
- The local-only "lemonade cache" and "incomplete" tokens describe the local
  machine. A peer-aware version (new `peers/[name]/lemonade-cache` and reuse of
  `peers/[name]/incomplete`) is **out of scope** for this iteration.

## Data flow

1. Picker resolves the file list on the local server: `hf-files` (HF metadata)
   or the Lemonade catalog (`lemonade-models`) — both machine-agnostic.
2. Picker POSTs the download request to `downloadTarget(...).url`.
3. For a remote target, the local server's proxy streams the request to the
   peer's `hf-download`; the peer downloads into its storage, records sources,
   and optionally copies to its own cold storage.
4. The streamed terminal output flows back through the proxy to the modal,
   parsed by the existing `parseProgress` / `parseNotices`.
5. On close, the Lemonade/Home client refreshes the affected peer's inventory
   (existing `refreshPeerModels`-style refresh) so status markers update.

## Error handling

- Unknown peer name → 502/404 from the proxy → `Error:` line in the modal.
- Unreachable/erroring remote peer → 502 with the message → `Error:` line.
- Client cancel → abort propagates to the peer, which kills its `hf` process.
- Path-safety validation (`REPO_ID_RE`, `FILE_PATH_RE`, `hasUnsafeSegment`)
  stays in the download handler, so it runs on whichever machine executes the
  download — unchanged.

## Testing

- `lib/locations` tests: extend to assert the HF view now resolves on a remote
  peer (and still 404s on cold storage).
- `lib/download-target` unit tests: All → local URL+path; local peer → local;
  remote peer → `/api/v1/peers/<name>/hf-download` + resolved path; missing
  `base_path` → placeholder fallback.
- The streaming proxy stays thin and mirrors the existing peer proxies; covered
  by manual/integration verification rather than a new unit harness.

## Out of scope

- A per-download peer/destination picker (rejected: target by tab).
- Peer-aware Lemonade cache / incomplete markers on remote tabs.
- Downloading to multiple machines at once or download-then-fan-out copy.

## Files touched

New:

- `lib/hf-download-stream.ts` — extracted streamer.
- `lib/download-target.ts` (+ test) — client target resolution.
- `app/api/v1/peers/[name]/hf-download/route.ts` — streaming proxy.

Modified:

- `app/api/v1/hf-download/route.ts` — call the shared streamer.
- `components/hf-download/download-runner.tsx` — target-aware `useDownloadRunner`.
- `components/hf-download/hf-download-picker.tsx`,
  `components/lemonade/lemonade-browser.tsx` — target + `canDownload` for
  remote peers.
- `components/hf-download/hf-download-client.tsx`,
  `components/lemonade/lemonade-client.tsx` — pass through the active
  location / peers as needed.
- `components/chrome/app-chrome.tsx` — `AddModelMenu` gate.
- `lib/locations.ts` — `parseRoute` HF-on-remote.
- `lib/locations.test.ts` — coverage.
