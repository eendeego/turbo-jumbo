# Audit check for missing mmproj (vision projector) files

## Goal

When a vision model's weights are present locally but its `mmproj` projector is
not, the audit should flag the model as incomplete and offer to download the
projector. Downloading the model fresh via the Lemonade browser already fetches
the mmproj; this closes the gap for models that were downloaded earlier (or
through the plain HF picker) without it.

## Background

- The Lemonade catalog marks vision models with an `mmproj` companion (e.g.
  `mmproj-F16.gguf`). The download path (`matchVariantFiles` in `lib/lemonade.ts`)
  **already** appends that file — verified against the live repo and covered by
  an existing test. **No change is needed to the download path.**
- The audit (`app/api/v1/audit/route.ts`, `lib/audit.ts`) is per-file: it hashes
  each selected local file and compares size/sha256 against HuggingFace,
  producing per-file `AuditResult`s streamed as NDJSON. Statuses include
  `incomplete` (size mismatch / missing file), `misplaced`, `duplicate`, etc.
- The audit already has an **`incomplete` → "Re-download"** flow: when a result
  has `status: 'incomplete'` and an `hf` summary, the table shows a
  "Re-download" action (`components/models/models-table-client.tsx`) wired to
  `onRedownload` in `components/home/home-client.tsx`, which derives
  `{repoId, branch, repoPath}` from `hf.fileUrl` (`fileRefFromSummary`) and
  downloads the file into `hf.expectedPath` via the download runner, then
  re-audits. **This feature reuses that flow wholesale.**
- Table rows form a tree: depth 0 = model (its `paths` aggregate all the
  model's files; its `key`/`parentName` is the model name, which for these
  models is the `repoId`), depth 1 = quant, depth 2 = shard. The audit
  column's `renderCell` gathers a row's verdict (`rowAudit`) and `failures`
  from `item.paths`.

## Design decisions (settled during brainstorming)

1. **Source of truth: the HF repo listing.** A model is expected to have an
   mmproj when its HF repo contains an `mmproj*.gguf` file — covering any vision
   model regardless of how it was obtained.
2. **Behavior: flag + offer to download**, reusing the existing
   `incomplete` → "Re-download" machinery.
3. **Surfacing: attach to the model (depth-0) row** (least plumbing), via the
   audit column's `renderCell`.
4. **Variant preference when several mmproj exist:** `mmproj-F16` → `mmproj-BF16`
   → `mmproj-F32` → first listed (case-insensitive).
5. **Scope: local audits only** (where re-download exists). Cold storage and
   peers are out of scope.

## Components

### 1. Repo file listing — `lib/hf-infer.ts`

Export a thin wrapper over the existing private `fetchTree` + `treeEntryToInfo`:

```ts
/** Every file in a repo at a branch as resolved HfFileInfo, or null on fetch
 *  failure. Reuses the module's tree cache. */
export async function listRepoFiles(
  repoId: string,
  branch: string,
): Promise<HfFileInfo[] | null>;
```

Returns one `HfFileInfo` (repoId, branch, repoPath, commit, commitDate, size,
sha256) per `type === 'file'` tree entry.

### 2. Pure mmproj helpers — new module `lib/mmproj.ts`

Kept separate so `lib/audit.ts` (already large) stays focused. Pure and
unit-tested.

```ts
const MMPROJ_PREFERENCE = ['mmproj-f16', 'mmproj-bf16', 'mmproj-f32']; // lower-cased basenames

const isMmprojName = (basename: string) =>
  basename.toLowerCase().startsWith('mmproj') &&
  basename.toLowerCase().endsWith('.gguf');

/**
 * Choose which mmproj repoPath a repo's file list offers, by preference order
 * (F16 → BF16 → F32 → first encountered). Null when the repo lists no mmproj.
 * `repoPaths` are in-repo paths (basenames for root-level mmproj files).
 */
export function pickMmproj(repoPaths: string[]): string | null;

/**
 * Whether any local file is an mmproj belonging to `repoId`, across layouts:
 * a flat-mirror path `<repoId>/…/mmproj*.gguf` (via pathImpliedRepo) or a
 * hub-cache path decoding to `repoId` (via parseHubCachePath). `relPaths` are
 * storage-root-relative paths from the scan.
 */
export function hasLocalMmproj(relPaths: string[], repoId: string): boolean;
```

`pickMmproj` matches on the basename of each repoPath (mmproj files live at the
repo root in practice, but compare basenames to be safe).

### 3. Detection orchestration — `lib/mmproj.ts`

```ts
/**
 * Synthetic `incomplete` AuditResults for repos that have an mmproj on HF but
 * none locally. One result per repo (the preferred variant). Repos whose tree
 * fetch fails are skipped (no false flag). `allRelPaths` is every path in the
 * local scan; `repoIds` are the distinct repos to check.
 */
export async function detectMissingMmproj(
  repoIds: string[],
  allRelPaths: string[],
  branch: string, // 'main'
): Promise<AuditResult[]>;
```

For each repoId: `listRepoFiles` → collect `isMmprojName` repoPaths → if empty,
skip. If `hasLocalMmproj(allRelPaths, repoId)`, skip. Else `pickMmproj` → find
the matching `HfFileInfo` → build the result:

```ts
const summary = hfSummary(hf); // existing, in lib/audit.ts
{
  file: expectedRelPath(hf), // `${repoId}/${repoPath}`
  status: 'incomplete',
  message: 'vision projector not downloaded',
  hf: summary,
}
```

`expectedRelPath` and `hfSummary` are imported from `lib/audit.ts`.

### 4. Wire detection into the audit run — `app/api/v1/audit/route.ts`

The route already scans models (`scanModels(basePath)`) and streams per-file
results. After the file-audit jobs finish (and only for local — i.e. not cold
storage and not proxied to a peer):

1. Derive the candidate repos: for each selected relPath, find the scanned model
   that owns it; keep `model.name` values containing `/` (these are repo ids
   from sidecar / cache / flat layout). Dedupe.
2. `allRelPaths` = every file path across the scanned models (single files and
   each split shard).
3. `const extra = await detectMissingMmproj(repoIds, allRelPaths, 'main');`
4. Emit each `extra` result on the same NDJSON stream (via the existing `emit`).

Cold-storage and peer audits skip steps 1–4 (re-download isn't available there).

### 5. Register streamed-but-unselected verdicts — `components/home/home-client.tsx`

Today `auditedPaths` is seeded only from the selected paths + cached keys; a
streamed result's `file` is added to `auditResults` but not `auditedPaths`, and
`rowAudit` filters by `auditedPaths`. The synthetic mmproj path is in neither the
selection nor the cache, so add it when its result streams in. In the audit
result handler, alongside the existing `setAuditResults`:

```ts
setAuditedPaths((prev) =>
  prev.has(event.file) ? prev : new Set(prev).add(event.file),
);
```

This is a general correctness fix (any streamed result now registers), not
mmproj-specific.

### 6. Surface on the model row — `components/models/models-table-client.tsx`

In the audit column's `renderCell`, for the **depth-0** row only, augment the
path list fed to both `rowAudit` and the `failures` lookup with any audit-result
keys that belong to this model but aren't already row paths (the synthetic
companion):

```ts
const results = auditResults ?? new Map<string, AuditResult>();
const companionPaths =
  item.depth === 0
    ? [...results.keys()].filter(
        (p) => p.startsWith(item.key + '/') && !item.paths.includes(p),
      )
    : [];
const auditPaths = [...item.paths, ...companionPaths];
// use auditPaths in place of item.paths for rowAudit(...) and the failures map
```

`item.key` is the model name (= repoId), so the synthetic path
`<repoId>/mmproj-F16.gguf` attaches to exactly the one model row; quant/shard
rows (depth 1/2) are unaffected, so there's no duplication. The existing
`AuditCell` then shows the model row's verdict as **Incomplete** and lists the
missing projector with the existing **Re-download** button — no changes to
`AuditCell`, `rowAudit`, or `home-client`'s `onRedownload`.

## Data flow

```
local audit run
  → per-file AuditResults (existing)
  → detectMissingMmproj(repoIds, allRelPaths, 'main')   [lib/mmproj.ts]
      listRepoFiles → pickMmproj / hasLocalMmproj → hfSummary/expectedRelPath
  → synthetic {file:'<repo>/mmproj-F16.gguf', status:'incomplete', hf} on NDJSON
  → home-client: result added to auditResults AND auditedPaths
  → models-table-client: depth-0 renderCell augments paths with the companion
  → model row shows "Incomplete" + "Re-download"
  → onRedownload (existing) downloads via runner into hf.expectedPath, re-audits
```

## Error handling

- A repo whose `listRepoFiles` returns null (HF unreachable / not found) is
  skipped — no synthetic result, no false flag (matches the audit's existing
  tolerance for HF failures).
- A repo with no mmproj on HF → nothing emitted.
- An mmproj already present locally (any variant) → nothing emitted.
- A selected file with no derivable repo id (e.g. a bare flat GGUF with no repo
  directory and no sidecar) contributes no repoId and is simply not checked.

## Testing

Unit tests (`lib/mmproj.test.ts`), pure functions only:

- `pickMmproj`: F16 chosen over BF16/F32; BF16 when no F16; F32 when only F32;
  first when none of the preferred names match but an mmproj exists; null when
  the list has no mmproj.
- `hasLocalMmproj`: true for a flat-mirror `<repoId>/mmproj-F16.gguf`; true for a
  hub-cache path decoding to `repoId`; false when the only mmproj belongs to a
  different repo; false when no mmproj present.

`detectMissingMmproj` (network-dependent) and the client surfacing are verified
manually: audit a vision model whose projector is absent locally and confirm the
model row shows **Incomplete** with a working **Re-download** that fetches
`mmproj-F16.gguf` and clears the verdict on the follow-up audit.

## Out of scope

- Changing the download path (already fetches the mmproj).
- Cold-storage and peer audits (no re-download there).
- Detecting an _extra_/unexpected mmproj, or projector files for non-`.gguf`
  model formats.
