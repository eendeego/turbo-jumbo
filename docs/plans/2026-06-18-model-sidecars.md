# Model Sidecars Implementation Plan

**Goal:** Replace per-file `.tjmeta.json` sidecars with one `tjmodel.json` per
model directory holding full per-file provenance records, app-wide.

**Architecture:** Introduce a pure, unit-tested store module
(`lib/model-sidecar.ts`) that owns the `tjmodel.json` schema, the
file→model-dir mapping, per-model-serialized read/modify/write, and the
per-file merge. Later phases re-express `lib/audit.ts`'s
`readMeta`/`writeMeta`/`updateMeta`/move/copy over it, switch scan naming to
read the model sidecar, derive hub-cache manifests locally, and remove the
legacy per-file paths. Each phase leaves the app working; legacy sidecars
stay readable until the final phase.

Spec: `docs/specs/2026-06-17-hubcache-commit-sidecar-design.md`

**Phasing:**

1. Foundation: `lib/model-sidecar.ts` store + tests. No consumer changes.
2. Wire reads/writes: re-express `audit.ts` `readMeta`/`writeMeta`/
   `updateMeta`/`refreshMetaSource`/`observedMeta`/`auditFile` over the store
   (dual-readable: model sidecar, then legacy).
3. Scan naming: `models.ts` `sidecarRepoId` → `modelSidecarRepoId`.
4. Move/copy/fix/download: entry-move semantics in
   `moveFileWithMeta`/`copyFileWithMeta`/`fix-duplicates`/`hf-download`.
5. Hub-cache local derivation + remove legacy per-file write/read paths.

## Phase 1 — Foundation: `lib/model-sidecar.ts`

A self-contained module. No Astryx components, no consumer wiring, so the
running app is unchanged and everything is `bun test`-able.

### Task: Schema and the file→model-dir mapping

`TjModelFile` (a `TjMeta` minus the hoisted `modelUrl`) and `TjModel`
(`{modelUrl, repoId, files: TjModelFile[]}`).

`modelDirForRepo(relPath, repoId): {dir, key} | null` — the model directory
(storage-root-relative) that owns `relPath`, and the file's key within it,
given the file's resolved `repoId`. The repoId is required because a leading
path segment alone can't tell a one-part repo id (`gpt2`) from the org of a
two-part one. Returns null when the file isn't under its repo dir (a stray
file at the storage root carries no model sidecar by design).

- hub-cache: `models--<org>--<repo>/snapshots/<rev>/<repoPath>` → dir = the
  `models--…` segment, key = `<repoPath>`.
- flat: `<repoId>/<repoPath>` → dir = `<repoId>`, key = `<repoPath>`.

Tests: flat-layout mapping; hub-cache mapping; a single-part repo id; null
for a file not under its repo dir.

### Task: Per-file merge (`mergeFileMeta`)

Ports `audit.ts`'s `mergeMeta` semantics to the entry level so the store owns
it (a later phase has `audit.ts` delegate to this). The source block (urls,
commit pin, expected size/sha) moves atomically — wholesale from `next` when
it resolved a source, else from `prev`. The observed size is always fresh;
the computed hash carries from `prev` only while the on-disk size is
unchanged.

Tests: keeps a prior computed hash when size is unchanged; drops a stale
computed hash when size changed; takes the source block from `next` only
when `next` resolved one.

### Task: Read / write the sidecar file

`readModelSidecar(basePath, dir)` / `writeModelSidecar(basePath, dir, model)`
— plain JSON read/write at `<basePath>/<dir>/tjmodel.json`; read returns null
when absent.

Tests: write-then-read round-trips; read returns null when absent.

### Task: Serialized upsert + per-file read

A per-sidecar-path promise chain (`withSidecarLock`) serializes
read-modify-write so concurrent audits of files in one model don't clobber
each other's `tjmodel.json`.

`upsertFileMeta(basePath, dir, repoId, next: TjModelFile)` — read (or
initialize) the model sidecar, merge `next` into the matching entry via
`mergeFileMeta`, write back, all under the lock.

`readFileMeta(basePath, dir, key)` — read the model sidecar, find the entry
by `path`, return it as a `TjMeta` with `modelUrl` re-attached (or null).

Tests: two concurrent upserts of different files in one model both land
without clobbering; a same-size re-upsert with no new hash keeps the prior
hash; `readFileMeta` returns the entry as a `TjMeta`, or null when missing.

## Phase 2 — Wire reads/writes in `lib/audit.ts`

Re-express the per-file API over the store, keyed by
`(basePath, relPath, repoId)`. Each task: write a failing test against the
new behavior, change `audit.ts`, keep the legacy per-file read as a fallback
(non-destructive).

- `readMetaRel(basePath, relPath, repoId)` — resolve `modelDirForRepo`;
  return `readFileMeta`; on null, fall back to the legacy `readMeta(fullPath)`
  (per-file `.tjmeta.json`). `auditFile`/`cached`/`resolveSource` switch to
  it (they already have `basePath`, `relPath`, and a resolved
  `repoId`/`modelName`).
- `updateMetaRel(basePath, relPath, repoId, next)` — `modelDirForRepo` →
  `upsertFileMeta`; `observedMeta` produces a `TjModelFile` (drop `modelUrl`,
  add `path = key`). `auditFile`'s two `updateMeta` calls switch to it.
- `refreshMetaSource` — write through `upsertFileMeta`.
- `audit.ts`'s `mergeMeta` delegates to `mergeFileMeta` (or is removed once
  unused) to keep one merge implementation.

Each task ends with `bun test` + `bun typecheck` green and a commit. The app
keeps working because legacy sidecars are still read.

## Phase 3 — Scan naming (`lib/models.ts`)

`modelSidecarRepoId(dir)` — read `<dir>/tjmodel.json`, return `repoId`.
Replace `sidecarRepoId(fullPath)` in the scan precedence with a model-dir
lookup: for a candidate file, check its `<org>/<repo>` (or hub-cache) dir for
a `tjmodel.json`. Keep the legacy per-file `sidecarRepoId` as a fallback
until Phase 5. Test with a temp tree (model sidecar names the model; legacy
still works).

## Phase 4 — Move/copy/fix/download

- `moveFileWithMeta` — after moving the file, move its manifest entry:
  `removeFileMeta(base, fromDir, fromKey)` + `upsertFileMeta(base, toDir,
repoId, entryWithNewKey)`; drop an emptied source sidecar. New store fn
  `removeFileMeta(basePath, dir, key)` (+ delete the sidecar when it
  empties), tested in `model-sidecar.test.ts`.
- `copyFileWithMeta` — copy the entry into the destination sidecar instead of
  copying the per-file sidecar file.
- `lib/fix-duplicates.ts` — replace the per-file sidecar delete / write with
  `removeFileMeta` / `upsertFileMeta`.
- `app/api/v1/hf-download/route.ts` — replace the per-file sidecar
  rename/delete with entry move/remove.

Each task: failing test → change → `bun test`/`typecheck` green → commit.

## Phase 5 — Hub-cache derivation + remove legacy

- Hub-cache manifest: in `resolveSource` (or a model-level audit step), for a
  hub-cache file set `sourceCommit = rev`, `branch = main`, per-file `sha256`
  from the blob symlink target, `size` from `stat`; write via
  `upsertFileMeta`. Test the derivation over a temp hub-cache tree.
- Remove legacy paths: delete the per-file `readMeta`/`writeMeta`/
  `updateMeta` and the legacy fallbacks in `readMetaRel`/`modelSidecarRepoId`
  once a migration pass has folded existing `.tjmeta.json` into model
  sidecars (the fold-on-read in `readMetaRel`, run across a location by a
  normal audit, then delete the legacy file). Final `bun test`/`typecheck`/
  `lint` green.

## Verification (each phase)

- `bun test` — all pass.
- `bun typecheck` — clean.
- `bunx prettier --check` the changed files.
- App still serves.
