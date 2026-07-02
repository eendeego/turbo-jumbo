# Copy sidecar propagation

## Problem

The copy flow (`/api/v1/copy` and the routes it delegates to) moves only raw
weight bytes. Provenance sidecars — `tjmodel.json` entries and legacy
`.tjmeta.json` files — do not travel. After a copy, the destination shows a
filename-derived model name and audits as unverifiable until a full re-hashing
audit runs there. `copyFileWithMeta` (lib/audit.ts) handles only the legacy
per-file sidecar and is used only by the HF download stream, not by the copy
route.

## Decision

Provenance travels **per copied file**, merged at the destination — never by
copying sidecar files wholesale (a wholesale `tjmodel.json` copy would clobber
destination-only entries and plant entries for files never transferred).

Applies to **all copy destinations**: peer→peer, local→peer, peer→cold,
cold→peer, and local↔cold.

## Core semantics

After a file's bytes complete at the destination (and only then):

- **Source side** reads the file's provenance with the existing
  `readMetaResolved(srcBase, relPath)` → `TjMeta | null`. This already handles
  the legacy `.tjmeta.json` fallback and lazy migration. `null` → nothing
  travels (no fabricated provenance).
- **Destination side** applies it with the existing
  `updateMetaResolved(dstBase, relPath, repoId, meta, repoHead?)`, deriving
  `repoId` via `repoIdFromModelUrl(meta.modelUrl)`. That merges the entry into
  the model dir's `tjmodel.json` (per-dir write lock, `mergeFileMeta` —
  destination-only entries survive) or falls back to a legacy `.tjmeta.json`
  for stray files. When no `repoId` can be derived, apply with the plain
  legacy `updateMeta`.

Model-level `repoCommit`/`repoCommitDate`: the source forwards the values from
its model sidecar alongside the entry; the destination applies them **only when
its own sidecar records none**. A copy is not a fresh HF resolution and must
not clobber a newer observation at the destination.

Skipped-conflict files get no meta — only transferred bytes carry provenance.

Meta propagation is best-effort per file: a failure is logged and reported in
the run's existing `errors` array, but the byte copy stands.

## Transfer legs

| Leg | Hook location | Meta transport |
| --- | --- | --- |
| local → remote peer | `/api/v1/copy` upload branch | HTTP POST to `file-meta` on dest |
| remote → peer | `local-models/push` (runs on source peer) | HTTP POST to `file-meta` on dest |
| cold → remote peer | `cold-storage/to-local` (runs on dest peer) | direct: read cold mount, upsert local |
| remote → cold | `cold-storage/from-local` (runs on source peer) | direct: read local, upsert cold mount |
| local ↔ cold (this host) | `/api/v1/copy` final branch | direct: read src base, upsert dst base |

The cold legs need no network hop: cold storage is a shared mount and the code
already runs on the machine holding both paths.

## New pieces

- **Route** `POST /api/v1/local-models/file-meta` — body
  `{path: string, meta: TjMeta, repoHead?: {id: string, date?: string}}`.
  Validates the path resolves within `localModelsDir` and the meta shape, then
  applies the destination logic above. Every peer serves it.
- **Lib module** `lib/copy-meta.ts`:
  - `readMetaWithRepoHead(srcBase, relPath)` → `{meta, repoHead} | null` —
    source-side read (entry + model-level commit).
  - `applyFileMeta(dstBase, relPath, meta, repoHead?)` — destination-side
    apply, including the apply-repoHead-only-if-absent rule.
  - `propagateFileMeta(srcBase, dstBase, relPath)` — read + apply, for the
    three local legs.
  - `sendFileMeta(peerAddr, relPath, meta, repoHead?)` — HTTP POST for the two
    network legs.

## Testing

Co-located `lib/copy-meta.test.ts` with temp dirs:

- merging into an existing destination `tjmodel.json` keeps destination-only
  entries;
- a stray file (no model dir) falls back to a legacy `.tjmeta.json`;
- absent source meta is a no-op;
- `repoCommit`/`repoCommitDate` apply only when the destination lacks them.

## Out of scope (noted, unchanged)

`deleteAfterCopy` and `DELETE /api/v1/local-models` already leave stale sidecar
entries at the source; this work does not change that.
