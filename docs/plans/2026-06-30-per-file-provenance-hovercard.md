# Per-file provenance hovercard — Implementation Plan

**Goal:** Give every file-bearing row in an expanded model a per-file
provenance hovercard drawn from its `tjmodel.json` record (source revision,
sizes, checksums, origin link), surfacing local values only when they diverge.

**Architecture:** Matching happens server-side at each data source
(`scanModels` attaches the raw records; `buildModelRows` / `repoFileStatuses`
resolve them per row; `buildDisplayRows` copies them through); the client only
renders what's attached. Rows with no record render plain text.

**Tech Stack:** Next.js 16 App Router, React, TypeScript (strict), Bun test,
Jujutsu (`jj`).

**Spec:** `docs/specs/2026-06-30-per-file-provenance-hovercard-design.md`

---

## Global Constraints

- Package manager: `bun`. Tests: `bun test`. Lint: `bun lint`. VCS: `jj`; no
  `Co-Authored-By` trailer.
- Astryx UI: import components by bare names; no `XDS*` aliases.
- Per-task verification: `bun typecheck`, `bun lint`, `bun test` clean; UI
  tasks additionally `bun run build`. Format with `bunx prettier --write`.

---

### Task 1: `FileProvenance` type + `fileProvenance` and `summarizeFiles`

- In `lib/sidecar-types.ts`: `FileProvenance` (a `TjModelFile` without the
  manifest key), `fileProvenance(f)`, and `summarizeFiles(modelUrl, repoId,
files)` → `SidecarSummary` with `sourceCommit = deriveModelCommit(files)`
  and no `repoCommit`. Unit tests.
- Commit: `jj commit -m "Add FileProvenance, fileProvenance, and summarizeFiles helpers"`.

### Task 2: `Model.sidecarFiles` in `scanModels`

- Attach the sidecar's raw `files` array (`Model.sidecarFiles?:
TjModelFile[]`) alongside the existing summary.
- Commit: `jj commit -m "Attach the raw sidecar file records to each scanned model"`.

### Task 3: Match provenance to quant and shard rows in `buildModelRows`

- Per model, a manifest-key → record map (cold first, local wins; key =
  `modelDirForRepo(path, name)?.key`). Single-file quants get
  `QuantInfo.provenance`; split quants get `QuantInfo.provenanceAggregate`
  (via `summarizeFiles`) and per-shard `ShardInfo.provenance`.
- Commit: `jj commit -m "Match sidecar provenance to quant and shard rows"`.

### Task 4: Attach provenance to whole-repo file rows

- `repoFileStatuses` already reads each present file's meta; carry it as
  `RepoFile.provenance` (a `TjMeta` matches `FileProvenance`).
- Commit: `jj commit -m "Attach sidecar provenance to whole-repo file rows"`.

### Task 5: Copy provenance onto `DisplayRow`s

- `DisplayRow.provenance` on single-file quant / shard / whole-repo file
  rows; `DisplayRow.provenanceAggregate` on split-quant parent rows.
- Commit: `jj commit -m "Copy per-file provenance onto the display rows"`.

### Task 6: Render the per-file hovercards in `name-cell.tsx`

- `FileProvenanceInfo` (source revision + date, source size/sha256, ⚠ on-disk
  size and computed sha256 only when they diverge, origin link); split rows
  reuse `SidecarInfo` for the aggregate. Wrap each row label in a `HoverCard`
  only when the row carries data.
- Commit: `jj commit -m "Show per-file provenance hovercards on file rows"`.

## Self-Review

- No provenance for missing files or size-mismatch-invalid whole-repo files.
- No change to how sidecars are written or audited.
- The model row's existing hovercard is unchanged.
