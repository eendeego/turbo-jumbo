# Remote-peer model downloads — Implementation Plan

**Goal:** Let a user download HF and Lemonade models onto a remote peer, with
the download running on that peer into its own storage.

**Architecture:** Add a streaming proxy route (`peers/[name]/hf-download`) that
forwards the existing `hf-download` request to the selected peer's own
endpoint; the client targets the peer of the active tab. The download executes
on the peer via the same code that already runs there.

**Tech Stack:** Next.js 16 App Router, React, TypeScript (strict), Bun test,
Jujutsu (`jj`).

**Spec:** `docs/specs/2026-06-29-remote-peer-downloads-design.md`

---

## Global Constraints

- Package manager: `bun`. Tests: `bun test`. Lint: `bun lint`. VCS: `jj`; no
  `Co-Authored-By` trailer.
- Astryx UI: import components by bare names (`@astryxdesign/core/<Name>`); no
  `XDS*` aliases.
- Per-task verification: `bun typecheck`, `bun lint`, `bun test` clean; UI
  tasks additionally `bun run build`. Format with `bunx prettier --write`.

---

## File Structure

| File                                            | Action | Responsibility                                     |
| ----------------------------------------------- | ------ | -------------------------------------------------- |
| `lib/hf-download-stream.ts`                     | Create | Extracted `streamHfDownload(body, signal)` core    |
| `lib/download-target.ts` (+ test)               | Create | `downloadTarget()` / `peerModelsDir()` helpers     |
| `app/api/v1/peers/[name]/hf-download/route.ts`  | Create | Streaming proxy: local → streamer, remote → fetch  |
| `app/api/v1/hf-download/route.ts`               | Modify | Thin caller of the shared streamer                 |
| `lib/locations.ts` (+ test)                     | Modify | Allow the HF view on remote peers                  |
| `components/hf-download/download-runner.tsx`    | Modify | `useDownloadRunner(displayPath, downloadUrl)`      |
| `components/hf-download/hf-download-picker.tsx` | Modify | Takes a `DownloadTarget` prop                      |
| `components/hf-download/hf-download-client.tsx` | Modify | Computes the target from the active location       |
| `components/lemonade/lemonade-browser.tsx`      | Modify | Target-aware runner + target-peer skip inventory   |
| `components/lemonade/lemonade-client.tsx`       | Modify | Computes target/targetName; widens `canDownload`   |
| `components/chrome/app-chrome.tsx`              | Modify | `canAddModel` gate shows Add model on remote peers |

---

### Task 1: Extract the HF download streamer

- Move the route's streaming body (validation regexes, `recordSources`,
  `moveToColdstorage`, the `ReadableStream` spawn) into
  `lib/hf-download-stream.ts` as `streamHfDownload(body, signal): Response`;
  the route keeps its `readJsonBody` + no-local-peer guard and delegates.
- Commit: `jj commit -m "Extract the HF download streamer into lib/hf-download-stream"`.

### Task 2: `downloadTarget` client helper

- `lib/download-target.ts`: `peerModelsDir(peer)` (base_path +
  `turbo_jumbo_subdir ?? 'turbo-jumbo'`) and
  `downloadTarget(activeLocation, peers, localModelsPath)` → `{url,
displayPath}`; All/local → the local route, remote →
  `/api/v1/peers/<name>/hf-download` with the peer's resolved dir (placeholder
  when `base_path` is unset). Unit tests for all four cases.
- Commit: `jj commit -m "Add downloadTarget: map the active tab to a download endpoint"`.

### Task 3: Allow the HF view on remote peers

- `parseRoute`: the `download/hf` branch accepts any non-cold-storage
  location, mirroring Lemonade's. Update `lib/locations.test.ts` (remote-peer
  hf resolves; cold storage still nulls; `hfHref` covers a remote peer).
- Commit: `jj commit -m "Allow the HF download view on remote peers"`.

### Task 4: Peer download proxy route

- `app/api/v1/peers/[name]/hf-download/route.ts`: 404 unknown peer; local peer
  → `streamHfDownload`; remote → fetch the peer's `hf-download` and pipe
  `res.body` back with `text/plain`, 502 on failure, `req.signal` forwarded.
- Commit: `jj commit -m "Add a streaming peer hf-download proxy route"`.

### Task 5: Make `useDownloadRunner` target-aware

- Signature becomes `useDownloadRunner(displayPath, downloadUrl =
'/api/v1/hf-download')`; runs POST to `downloadUrl`, command previews use
  `displayPath`. Existing single-argument callers keep local behavior.
- Commit: `jj commit -m "Make useDownloadRunner target a configurable download URL"`.

### Task 6: Route the HF picker to the active peer

- `HfDownloadPicker` takes `target: DownloadTarget` instead of
  `localModelsPath`; `hf-download-client.tsx` computes it with
  `downloadTarget(activeLocation, peerConfigs, localModelsPath)`.
- Commit: `jj commit -m "Route the HF download picker to the active peer"`.

### Task 7: Route the Lemonade browser to the active peer

- `LemonadeBrowser` takes `target` + `targetName`; the runner uses the target,
  and the "skip already-present files" reads the target peer's inventory
  (matched by name) instead of the local one. `lemonade-client.tsx` computes
  both and widens `canDownload` to any peer tab.
- Commit: `jj commit -m "Route the Lemonade browser to the active peer"`.

### Task 8: Show "Add model" on remote-peer tabs

- `app-chrome.tsx`: new `canAddModel` gate (All or any peer) for
  `AddModelMenu`; Consolidate keeps the stricter local-only gate.
- Commit: `jj commit -m "Show the Add model dropdown on remote-peer tabs"`.

### Task 9: Full verification

- `bun typecheck`, `bun lint`, `bun test`, `bun run build` all clean; smoke
  the `/download/hf` and `/download/lemonade` views.

## Self-Review

- No per-download peer picker: target = active tab, All = local (approved).
- The cold-storage checkbox operates on the executing peer's own cold storage.
- Path-safety validation runs on whichever machine executes the download.
