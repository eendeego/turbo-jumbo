# Sidecar model hovercard — Implementation Plan

**Goal:** Show a model's sidecar (`tjmodel.json`) provenance — recorded source
revision, repo HEAD, and a file roll-up — in the hovercard on the model name.

**Architecture:** The summary is derived from the sidecar during the existing
synchronous scan (`scanModels`) and rides the server → client row data
(`Model.sidecar` → `ModelRow.sidecar` → depth-0 `DisplayRow.sidecar`); the
name-cell hovercard renders it. No new endpoint, no lazy fetch.

**Tech Stack:** Next.js 16 App Router, React, TypeScript (strict), Bun test,
Jujutsu (`jj`).

**Spec:** `docs/specs/2026-06-30-sidecar-model-hovercard-design.md`

---

## Global Constraints

- Package manager: `bun`. Tests: `bun test`. Lint: `bun lint`. VCS: `jj`; no
  `Co-Authored-By` trailer.
- Astryx UI: import components by bare names; no `XDS*` aliases.
- Per-task verification: `bun typecheck`, `bun lint`, `bun test` clean; UI
  tasks additionally `bun run build`. Format with `bunx prettier --write`.

---

### Task 1: `SidecarSummary` type and `summarizeModel` helper

- In `lib/model-sidecar.ts`: the `SidecarSummary` interface (repoId, modelUrl,
  optional sourceCommit/repoCommit/repoCommitDate, fileCount,
  totalSourceSize) and the pure `summarizeModel(model: TjModel)` that counts
  files, sums `sourceSize`, and passes the commits through (including
  `MIXED_COMMIT`). Unit tests for the roll-up and sparse sidecars.
- Commit: `jj commit -m "Add summarizeModel: a sidecar's model-level summary"`.

### Task 2: Sync sidecar read + `Model.sidecar` in `scanModels`

- A sync read that walks up from a file's directory to the nearest
  `tjmodel.json` (sharing the walk `modelSidecarRepoId` uses), parses it, and
  returns `summarizeModel(parsed)` or null. `Model.sidecar?: SidecarSummary`
  set once per model from the first file that resolves one.
- Commit: `jj commit -m "Read each model's sidecar summary during the scan"`.

### Task 3: Carry the summary onto `ModelRow`

- `buildModelRows` sets `ModelRow.sidecar`, preferring the local scan's
  sidecar and falling back to the cold scan's. Peer-only augmented rows carry
  none. Tests for the local-over-cold preference.
- Commit: `jj commit -m "Carry the sidecar summary onto the model row, local over cold"`.

### Task 4: Copy the summary onto the depth-0 `DisplayRow`

- `buildDisplayRows` copies `m.sidecar` onto the model (depth-0) row only.
  Test that quant rows don't carry it.
- Commit: `jj commit -m "Copy the sidecar summary onto the depth-0 display row"`.

### Task 5: Render the sidecar block in the name-cell hovercard

- Enrich the depth-0 hovercard: keep Repository + Quantizations; append
  Source revision (12-char hash linked to `<modelUrl>/commit/<sha>`, `mixed`
  as plain text), Repo HEAD (hash + date), and Files (count · size). Rows with
  absent fields are omitted; no sidecar leaves the card unchanged.
- Commit: `jj commit -m "Show the sidecar model summary in the name hovercard"`.

## Self-Review

- Model-level summary only; per-file provenance stays in the audit hovercard.
- Depth-0 rows only; quant/shard/file rows unaffected.
- No change to how sidecars are written or audited.
