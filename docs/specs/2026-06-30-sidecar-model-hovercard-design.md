# Sidecar model hovercard

## Goal

Show a model's sidecar (`tjmodel.json`) provenance in the hovercard that already
pops on the model name. Today that card shows only derived display data
(Repository + Quantizations); enrich it with the sidecar's model-level fields so
the recorded source revision, repo HEAD, and a file roll-up are visible at a
glance.

## Scope

- **Model-level summary only.** No per-file rows. The sidecar's per-file
  provenance (paths, individual sizes, checksums) is out of scope — the audit
  hovercard already surfaces per-file detail where it matters.
- **Depth-0 model rows only.** Quant/shard/file rows are unaffected.
- The summary is read during the existing synchronous model scan and carried to
  the client on the row data — no new API endpoint, no lazy fetch.

## Data path

The table is server-rendered: `getModelsTableData()` → `scanModels()` →
`buildModelRows()` → `ModelRow[]` → client. `scanModels` already reads sidecars
synchronously (for the repo id). The summary rides the same path.

1. **`SidecarSummary` type** (in `lib/model-sidecar.ts`):

   ```ts
   export interface SidecarSummary {
     repoId: string;
     modelUrl: string;
     sourceCommit?: string; // file-derived; may be MIXED_COMMIT ('mixed')
     repoCommit?: string; // repo HEAD commit
     repoCommitDate?: string; // ISO 8601 date of repoCommit
     fileCount: number; // files.length
     totalSourceSize: number; // sum of each file's sourceSize
   }
   ```

   Plus a pure helper `summarizeModel(model: TjModel): SidecarSummary` that
   derives the summary from a parsed sidecar (so it's unit-testable without the
   filesystem).

2. **Sync read helper** in `lib/models.ts`: `modelSidecarSummary(fullPath,
storagePath)` walks up from a file's directory to the nearest ancestor
   holding a `tjmodel.json` (the same walk `modelSidecarRepoId` already does),
   parses it, and returns `summarizeModel(parsed)` — or null when none is found
   or the JSON is unparseable. Reuse/extract the shared walk so there's one
   place that finds the sidecar dir.

3. **`Model.sidecar`**: add optional `sidecar?: SidecarSummary` to the `Model`
   interface. `scanModels` sets it once per model (the model's files share one
   sidecar dir), from the first file that resolves one.

4. **`ModelRow.sidecar`**: `buildModelRows` carries the summary onto the row,
   **preferring the local scan's sidecar, falling back to the cold scan's** when
   the local copy has none. Peer-only augmented rows
   (`augmentWithPeerOnlyQuants`) have no sidecar (undefined) — unchanged.

5. **`DisplayRow.sidecar`**: `buildDisplayRows` copies `m.sidecar` onto the
   depth-0 row only.

## Hovercard UI (`components/cells/name-cell.tsx`)

Enrich the existing depth-0 `HoverCard`. Keep Repository + Quantizations; append
a sidecar block when `row.sidecar` is present. Layout follows
`size-mismatch-hover.tsx`'s label/value pattern (`Text type="supporting"` label,
`Text type="body"` value).

```
Repository        unsloth/gpt-oss-20b-GGUF
Quantizations     Q4_K_M, Q8_0

Source revision   a1b2c3d4e5f6 ↗
Repo HEAD         f6e5d4c3b2a1 ↗ (2026-06-12)
Files             14 · 12.4 GB
```

- **Source revision** = `sourceCommit`, rendered as a 12-char hash linked to
  `<modelUrl>/commit/<sha>` (the audit-cell commit-link pattern). When the value
  is `MIXED_COMMIT`, render `mixed` as plain text (no link — files disagree).
- **Repo HEAD** = `repoCommit` (12-char hash, linked the same way) plus
  `repoCommitDate` sliced to `YYYY-MM-DD` in parentheses when present. The whole
  row is omitted when `repoCommit` is absent.
- **Files** = `fileCount` · `formatSize(totalSourceSize)`.
- Each row is omitted when its field is absent, so a sparse sidecar shows only
  what it has.
- **No sidecar** (`row.sidecar` undefined) → the card is unchanged from today:
  Repository + Quantizations only.

Commit links are inline `<a target="_blank" rel="noopener noreferrer">` styled
like the existing audit-cell links. A small `commitUrl(modelUrl, sha)` helper
builds the URL.

## Testing

- `summarizeModel` (pure): file count and summed `totalSourceSize`; passes
  through `sourceCommit`/`repoCommit`/`repoCommitDate`; handles `MIXED_COMMIT`;
  handles a sidecar with no commits (fields omitted).
- `buildModelRows` sidecar carry: local sidecar preferred; cold fallback when
  local absent; undefined when neither has one.
- `buildDisplayRows`: summary lands on the depth-0 row only, not on quant rows.

UI rendering is verified by inspection in the running app (consistent with how
the existing hovercards in this codebase are covered).

## Out of scope

- Per-file provenance rows in the hovercard.
- Surfacing the summary on quant/shard/whole-repo-file rows.
- Any change to how sidecars are written or audited.
