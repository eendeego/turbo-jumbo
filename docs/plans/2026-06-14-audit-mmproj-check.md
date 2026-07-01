# Audit mmproj-Check Implementation Plan

**Goal:** During a local audit, flag a vision model whose `mmproj` projector
is present on HuggingFace but missing locally, and let the existing
"Re-download" flow fetch it.

**Architecture:** A pure module `lib/mmproj.ts` decides which mmproj a repo
should have and whether one exists locally; an async `detectMissingMmproj`
(using a new `listRepoFiles` in `lib/hf-infer.ts`) emits synthetic
`incomplete` `AuditResult`s carrying an `hf` summary. The audit route streams
them after the per-file audits; the client registers them and surfaces them
on the model row, where the existing re-download button downloads the
projector.

Spec: `docs/specs/2026-06-14-audit-mmproj-check-design.md`

## File structure

- `lib/mmproj.ts` (create) — pure helpers `isMmprojName`, `pickMmproj`,
  `hasLocalMmproj`, and the async `detectMissingMmproj`. Server-only (imports
  `lib/audit`, `lib/hf-infer`, `lib/hf-cache`).
- `lib/mmproj.test.ts` (create) — unit tests for the pure helpers.
- `lib/hf-infer.ts` (modify) — export `listRepoFiles(repoId, branch)`.
- `app/api/v1/audit/route.ts` (modify) — run `detectMissingMmproj` after the
  per-file audits (local only) and emit its results.
- `components/home/home-client.tsx` (modify) — register streamed result
  paths in `auditedPaths`.
- `components/models/models-table-client.tsx` (modify) — surface companion
  verdicts on the depth-0 model row.

## Task 1: Pure mmproj helpers in `lib/mmproj.ts`

`isMmprojName(name)` — a GGUF projector file (`mmproj-F16.gguf`, …).

`pickMmproj(repoPaths)` — which mmproj a repo's in-repo paths offer: the
preferred precision (F16 → BF16 → F32), else the first mmproj listed, else
null when the repo has none.

`hasLocalMmproj(relPaths, repoId)` — whether any local file is an mmproj
belonging to `repoId`, across layouts: a flat-mirror path
`<repoId>/…/mmproj*.gguf` (via `pathImpliedRepo`) or a hub-cache path
decoding to `repoId` (via `parseHubCachePath`).

Test cases: F16 preferred over BF16/F32; BF16 when no F16; F32 when it's the
only preferred match; first mmproj when none match the preference list; null
with no mmproj; local match via flat-mirror path; local match via hub-cache
path; false when the only mmproj belongs to a different repo; false with no
mmproj present.

## Task 2: `listRepoFiles` + `detectMissingMmproj`

`listRepoFiles(repoId, branch)` in `lib/hf-infer.ts` — every file in a repo
at a branch as resolved `HfFileInfo`, or null on fetch failure, reusing the
existing tree cache and `treeEntryToInfo`.

`detectMissingMmproj(repoIds, allRelPaths, branch)` in `lib/mmproj.ts` —
for each repoId: `listRepoFiles` → `pickMmproj` over the repo's paths → skip
if none; skip if `hasLocalMmproj` is already true; otherwise build a
synthetic `AuditResult`:

```ts
{
  file: expectedRelPath(hf), // `${repoId}/${repoPath}`
  status: 'incomplete',
  message: 'vision projector not downloaded',
  hf: hfSummary(hf),
}
```

`expectedRelPath`/`hfSummary`/`AuditResult` come from `lib/audit.ts`.
Network-dependent, verified by typecheck plus the manual check in Task 4 (no
unit test).

## Task 3: Emit missing-mmproj verdicts from the audit route

In `app/api/v1/audit/route.ts`, after the per-file worker pool finishes and
only for `body.location === 'local'`: build `allRelPaths` (every path across
the scanned models, split shards included) and `repoIds` (distinct
`model.name` values containing `/` among models with at least one selected
file), call `detectMissingMmproj(repoIds, allRelPaths, 'main')`, and emit
each result on the existing NDJSON stream. Cold-storage and peer audits skip
this — no re-download exists there.

## Task 4: Surface the verdict on the model row and enable re-download

In `components/home/home-client.tsx`'s audit result handler, alongside the
existing `setAuditResults`, also register the streamed path in
`auditedPaths` (a general correctness fix: any streamed result now registers,
not just selected/cached ones):

```ts
setAuditedPaths((prev) =>
  prev.has(event.file) ? prev : new Set(prev).add(event.file),
);
```

In `components/models/models-table-client.tsx`'s audit-column `renderCell`,
for the depth-0 row, augment the paths fed to `rowAudit` and the failures
lookup with any result keys that belong to this model (`item.key` = repo id)
but aren't already row paths — the synthetic companion. `updates` (the HF
update check) stays on `item.paths` only; update checks apply to real local
files.

Manual verification: audit a vision model whose projector is absent locally
and confirm the model row shows **Incomplete** with a working
**Re-download** that fetches the projector and clears the verdict on the
follow-up audit; a model that already has its projector, and a non-vision
model, show no such verdict.

## Self-review

- `isMmprojName`/`pickMmproj`/`hasLocalMmproj`/`detectMissingMmproj`/
  `listRepoFiles` named identically everywhere they're defined and consumed.
- No new download code — the existing `incomplete` + `hf` →
  re-download path handles the fetch; `rowAudit`/the audit cell are
  otherwise unchanged.
- Out of scope: changing the download path, cold-storage/peer audits,
  detecting an unexpected extra mmproj, non-GGUF projector formats.
