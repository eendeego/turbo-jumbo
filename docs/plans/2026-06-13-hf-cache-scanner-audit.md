# HuggingFace Cache Layout: Scanner + Audit Understanding — Implementation Plan

**Goal:** Make the scanner and audit recognize files stored in the
`huggingface_hub` cache layout (`models--<org>--<repo>/snapshots/<rev>/<repoPath>`),
so a model downloaded through `hf`/Lemonade into that layout scans under the
right repo name, resolves its HuggingFace source by placement, audits as
correctly-placed (not "misplaced"), and is never falsely flagged a duplicate.

**Architecture:** Read-only increment. A new pure decoder (`lib/hf-cache.ts`)
turns a cache-relative path into `{repoId, rev, repoPath}`. The scanner
(`lib/models.ts`) names cache files by their decoded repo id instead of the
filename, fixing identity for free. The audit (`lib/audit.ts`) resolves the
source from the decoded repo, and a shared `isPlacedCorrectly` helper treats
both the flat `org/repo/<path>` layout and a matching cache path as correctly
placed. Nothing in the UI changes — the same `Model` / `AuditResult` shapes
flow through. Cache files are excluded from basename-based duplicate detection
because the cache structure guarantees per-repo uniqueness.

**Out of scope (explicitly deferred to follow-up plans):**

- Writing downloads into the cache layout (`HF_HUB_CACHE` interop) — write-side.
- Delete-side blob garbage collection — write-side.
- Safetensors multi-file quant grouping / dtype quant tokens — a separate
  "safetensors (flat)" effort. This plan handles cache-layout files of any
  extension for _naming and audit_, but does not solve quant grouping for
  multi-file safetensors repos.
- Cold-storage / peer presence joins for generic basenames — cosmetic
  presence hints, not verdicts; latent until a cache path is a configured
  location.

## Background facts

The `huggingface_hub` cache layout:

```
<root>/
  models--<org>--<repo>/
    refs/
      main                         # text file containing a commit SHA
    snapshots/
      <commit-sha>/
        <repoPath>      -> ../../blobs/<hash>     # symlink into blobs/
        sub/<repoPath>  -> ../../../blobs/<hash>
    blobs/
      <hash>                        # actual content (no file extension)
```

- The directory name encodes the repo id: `models--unsloth--Qwen3-0.6B-GGUF` ⇄
  `unsloth/Qwen3-0.6B-GGUF`. Decoding replaces `--` with `/`; a result that
  isn't exactly `org/repo` (one slash) is rejected.
- Snapshot files are **symlinks** into `blobs/`; the scanner already
  traverses a cache and finds these with correct sizes since `fs.statSync`
  follows symlinks. `blobs/<hash>` and `refs/main` have no model extension, so
  the existing extension filter already skips them. The only things wrong
  without this plan are the model _name_ (filename-derived instead of
  repo-derived) and the audit's placement/duplicate logic.
- Source resolution is against the branch head (`main`), per the existing
  "audit against the branch head, not a commit-pinned source" policy — the
  snapshot's `<rev>` is informational, not the resolution revision.
- Recognition is anchored at the storage root: a path is a cache path only
  when its **first** segment is `models--…`. Pointing a configured storage
  path at a parent of the cache won't match (safe: no false positives).

## File structure

- `lib/hf-cache.ts` — pure decoder `parseHubCachePath(relPath)`.
- `lib/hf-cache.test.ts` — decoder tests.
- `lib/models.ts` — scanner names cache files by decoded repo id (both the
  split-shard and single-file branches); `duplicateBasenames` skips cache
  paths.
- `lib/audit.ts` — `resolveSource` resolves a cache path's repo; exported
  `isPlacedCorrectly(relPath, repoId, repoPath)`; `decideStatus` and
  `cachedResultFromMeta` use it for the misplaced check.

## Tasks (all implemented; see the individual commits)

1. **Cache-path decoder** (`lib/hf-cache.ts`) — commit "Add a huggingface_hub
   cache-path decoder".
2. **Scanner names cache files by decoded repo id** — commit "Name
   cache-layout files by their decoded repo id when scanning".
3. **Exclude cache files from basename duplicate detection** — commit
   "Exclude cache-layout files from basename duplicate detection".
4. **`isPlacedCorrectly` accepts the cache layout** — commit "Treat the hub
   cache layout as correct placement in decideStatus".
5. **Resolve a cache file's source by its decoded repo** — commit "Resolve a
   cache-layout file's source from its decoded repo".
6. **Cached-verdict placement uses the cache layout too** — commit "Honor the
   cache layout in cached-verdict placement checks".

## Non-breaking guarantee

No UI file is touched. All changes are in `lib/` and preserve the `Model` /
`AuditResult` / `HfFileInfo` shapes. Existing flat-layout tests (the
basename-duplicate test, misplaced/pass tests in `lib/audit.test.ts`) keep
passing throughout.
