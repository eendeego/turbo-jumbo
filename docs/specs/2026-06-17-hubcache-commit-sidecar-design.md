# Model sidecars (replacing per-file sidecars)

## Overview

This app records provenance in per-file `.tjmeta.json` sidecars (`TjMeta`): one
file next to every model file, carrying its HuggingFace source URL, commit,
and the source/computed size and sha256 the audit established. This replaces
that with a single **model sidecar** (`tjmodel.json`) per model directory,
carrying a manifest of full per-file records. Per-file `.tjmeta.json` is
removed everywhere.

This started from hub-cache (`models--…/snapshots/<rev>/…`) models, whose
installed commit (`rev`, = `refs/main`) this app discarded. The model sidecar
captures that `rev` and, applied app-wide, unifies provenance into one
per-model file for flat-layout and hub-cache models alike.

> **Size:** this is a broad refactor of the provenance layer. It should be
> implemented in phases (see _Suggested phasing_), each leaving the app working.

## Artifact: `tjmodel.json`

One per model, at the model directory root:

- flat layout → `<org>/<repo>/tjmodel.json`
- hub-cache layout → `models--<org>--<repo>/tjmodel.json`

```ts
export interface TjModelFile {
  path: string; // file path relative to the model dir (the manifest key)
  originUrl: string; // HF file URL: blob/<branch>/<repoPath>
  sourceCommit?: string; // resolved commit for this file, when known
  sourceCommitDate?: string; // ISO 8601, when known
  sourceSize: number; // expected size from HF (0 if unknown)
  computedSize: number; // on-disk size observed at audit time
  sourceSha256: string; // '' when no source resolved
  computedSha256: string; // '' when not hashed
}

export interface TjModel {
  modelUrl: string; // https://huggingface.co/<repoId> (hoisted; shared by all files)
  repoId: string; // e.g. unsloth/GLM-4.7-GGUF
  files: TjModelFile[]; // keyed by `path`
}
```

`modelUrl`/`repoId` are hoisted to the model (shared); everything that can vary
per file — including `sourceCommit` (a flat repo's files can have different
last-modifying commits; a hub-cache model's files all share `rev`) — stays in
the manifest entry. A `TjModelFile` is a `TjMeta` minus the hoisted `modelUrl`,
so no information is lost relative to today's per-file sidecars.

## Model identity during the scan (the subtle part)

`scanModels` names a model by `cacheRepoId ?? sidecarRepoId(file) ?? flatRepoId
?? extractModelName(filename)`. `sidecarRepoId` reads a **per-file**
`.tjmeta.json` to recover the repo for files whose name/location don't reveal it.
Removing per-file sidecars means that signal must come from the model sidecar
instead.

Replace `sidecarRepoId(fullPath)` with `modelSidecarRepoId(dir)`: read
`tjmodel.json` from the file's directory (the `<org>/<repo>/` model dir) and
return its `repoId`. New precedence:
`cacheRepoId ?? modelSidecarRepoId(dir) ?? flatRepoId ?? extractModelName`.
A `tjmodel.json` thus marks a directory as a model and authoritatively names it.

## Reading provenance

`readMeta(fullPath)` keeps its `TjMeta` return type (so consumers —
`cachedResultFromMeta`, `auditFileUpdate`, `resolveSource`'s fallback — are
unchanged), but sources it from the model sidecar:

1. Read `tjmodel.json` from the file's model dir; find the manifest entry whose
   `path` matches the file.
2. Return `{modelUrl, ...entry}` as a `TjMeta`.
3. **Migration fallback:** if there's no `tjmodel.json` but a legacy
   `<file>.tjmeta.json` exists, read it, fold it into the model sidecar, and
   delete the legacy file (see _Migration_). Returns the same `TjMeta`.

## Writing provenance

All writes go to the model sidecar, keyed by the file's `path`:

- `updateMeta(fullPath, next)` → read the model sidecar, merge `next` into the
  file's entry (via the existing `mergeMeta` rules — preserve a prior
  `computedSha256` while the size is unchanged), write the model sidecar back.
- `writeMeta` / `refreshMetaSource` → upsert the file's entry likewise.
- **Concurrency:** the audit hashes up to `AUDIT_CONCURRENCY` files at once, and
  several may belong to one model — so read-modify-write of a shared
  `tjmodel.json` must be serialized. Use an in-process async mutex keyed by the
  sidecar path; writes are tiny, so serializing them per model is cheap.
- **Best-effort writes:** a model dir that isn't writable (e.g. a
  externally-owned hub-cache dir) logs and skips, as today.

## Moving and copying

- `moveFileWithMeta(base, from, to)`: move the file, then move its manifest
  entry — remove it from the source model's `tjmodel.json` and upsert it into
  the destination model's, rewriting `path` (and `originUrl` if the repo
  changed). When a source model sidecar loses its last entry, remove it.
- `copyFileWithMeta(src, dst)`: copy the file, then copy the entry into the
  destination model sidecar.
- The hf-download route's direct `metaPath` rename/delete of a per-file sidecar
  becomes a model-sidecar entry move/delete.

## Migration

Existing `.tjmeta.json` files remain on disk. Migration is **lazy and
lossless**: whenever `readMeta`/`updateMeta` touches a file, any legacy
`<file>.tjmeta.json` is folded into the model sidecar (preserving its computed
hashes) and then deleted. A normal audit pass thus migrates a location
incrementally without re-hashing. No separate migration command is required;
re-auditing a model with no sidecars at all rebuilds them as it does today.

## Hub-cache specifics (the original goal)

For a hub-cache model the manifest is derived locally from the cache layout —
`sourceCommit = rev` (the snapshot dir / `refs/main`), per-file `sha256` from the
blob symlink target (`blobs/<sha256>`), `size` from `stat` — with no HF request
or hashing. `originUrl` uses `branch = main` so the update check resolves the
branch and correctly flags when `main` has advanced past `rev` (fixing the
current bug where cache files record HF's HEAD and never flag updates). The
recorded `sha256` is HF's declared LFS object id (provenance), not a fresh
re-hash; byte verification stays a separate integrity audit.

## Edge cases & open points

- **Files not in a model dir.** A model sidecar needs a model dir to live in, so
  model sidecars apply only to files placed under `<org>/<repo>/` (or a hub-cache
  dir). A root-level / misplaced file carries no provenance until the audit's
  existing "misplaced" fix relocates it into its model dir, at which point it
  joins that model's `tjmodel.json` — this is accepted behavior. (Any legacy
  per-file sidecar still reads during the transition.)
- **Model dir not writable** (e.g. an externally-owned hub-cache dir): write is
  best-effort — logged and skipped, as today.

## Touchpoints

- `lib/audit.ts` — `TjMeta`→`TjModelFile`/`TjModel`; `metaPath`, `readMeta`,
  `writeMeta`, `updateMeta`, `mergeMeta`, `refreshMetaSource`, `observedMeta`,
  `moveFileWithMeta`, `copyFileWithMeta`, `auditFile`'s incremental writes.
- `lib/models.ts` — `sidecarRepoId` → `modelSidecarRepoId`; scan precedence.
- `lib/fix-duplicates.ts` — `metaPath` delete, `moveFileWithMeta`, `writeMeta`.
- `app/api/v1/audit/cached/route.ts`, `app/api/v1/audit/fix/route.ts`,
  `app/api/v1/hf-download/route.ts` — sidecar reads/moves/deletes.

## Testing

Pure `lib/` helpers, `bun test` over temp trees (real dirs/symlinks):

- model sidecar read/write/upsert round-trips; `mergeMeta` preserves a prior
  `computedSha256` while size is unchanged.
- `readMeta` returns a per-file `TjMeta` synthesized from `tjmodel.json`; legacy
  `<file>.tjmeta.json` is folded in and deleted on read (migration).
- `modelSidecarRepoId` names a model from its dir's `tjmodel.json`; scan
  precedence unchanged otherwise.
- hub-cache build derives `sourceCommit = rev`, per-file `sha256` from blob
  symlinks, `originUrl` on `branch = main`; non-symlink file → `sha256: ''`.
- `moveFileWithMeta`/`copyFileWithMeta` move/copy the manifest entry between
  model sidecars; emptied source sidecar is removed.

## Suggested phasing

1. `TjModel` schema + model-sidecar read/write/upsert lib (with per-model mutex)
   and the migration-fold-on-read fallback. `readMeta`/`writeMeta`/`updateMeta`
   re-expressed over it. (App keeps working; legacy sidecars still read.)
2. Scan naming: `modelSidecarRepoId`.
3. `moveFileWithMeta`/`copyFileWithMeta`/`fix-duplicates`/`hf-download` entry
   semantics.
4. Hub-cache local derivation in `resolveSource`/the audit.
5. Remove the legacy per-file write paths once migration is in place.

## Out of scope

- The Lemonade cache directory — not scanned, read-only to this app.
- Backfilling `commitDate` or any HuggingFace request in the hub-cache build.
- New endpoints or UI.
