# Audit Mode — Design

**Date:** 2026-06-08
**Status:** Approved (pending spec review)

## Summary

Add an **audit mode** to each location tab except **All**. Audit mode verifies the
integrity of the model files at a location against their HuggingFace source: every
file must have the **right size**, a **matching SHA256**, and be placed in the
**right directory**. The HuggingFace source is identified by **inferring the repo
from the filename**.

This first iteration implements the audit for the **locally-reachable tabs**
(the local peer and Cold Storage). Remote peer tabs show the audit toggle as
"not yet supported".

## Goals

- Per-tab audit toggle on every tab except All.
- On-demand audit (explicit "Run audit") because it hashes multi-GB files.
- Per-file integrity verdict: size, SHA256, and directory-structure correctness.
- Persist results in a per-file sidecar metadata file.

## Non-goals (this iteration)

- Auditing remote peer tabs (needs a peer sha256 endpoint + remote metadata writes).
- Recording authoritative provenance at download time (a future iteration writes
  `originUrl` / `sourceSha256` from the actual download).
- Re-downloading or re-hashing files that fail the audit (the one repair
  supported is relocating `Misplaced` files — see "Fixing misplaced files").
- A manual "specify the repo" override when inference fails.

## Source-of-truth: HuggingFace, inferred from filename

There is no stored provenance linking an on-disk file to an HF repo. Audit infers it:

1. Search HuggingFace GGUF repos by the model name
   (`https://huggingface.co/api/models?search=<modelName>&filter=gguf&limit=N`).
2. For each candidate repo, fetch its file tree and look for a file whose name
   **exactly matches** the local filename
   (`https://huggingface.co/api/models/<repo>/tree/<branch>?expand=true`,
   which includes `lfs.oid` = the sha256 and `size`).
3. The first repo containing an exact-filename match wins. From it we take:
   `repoId`, `branch`, `repoPath` (the file's path within the repo), `size`,
   and `sha256` (the LFS oid).
4. No match in any candidate → the file is **Unverifiable**.

**Known weakness:** filename→repo inference is unreliable. Expect a meaningful
fraction of `Unverifiable` results, especially for re-quantized or renamed files.
HF search/tree responses are cached per audit run to avoid rate limiting.

## Per-file audit algorithm (fail-fast)

For each file at the location:

1. **Infer HF source** (above). No match → `Unverifiable`; stop.
2. **Size check** — on-disk size (and shard completeness for splits) vs HF `size`.
   Mismatch / missing shards → `Incomplete`; stop (this is the fail-fast — no hashing).
3. **Compute SHA256** of the local file (`sha256sum`) and write the sidecar
   (`computedSha256`, and cache `sourceSha256` = inferred HF sha256).
4. **SHA256 check** — `computedSha256 === sourceSha256`. Mismatch → `Checksum mismatch`.
5. **Directory check** — the file's path relative to the storage root must equal
   the HuggingFace layout mirrored on disk, `<repoId>/<repoPath>` (e.g.
   `unsloth/FLUX.2-klein-9B-GGUF/flux-2-klein-9b-Q8_0.gguf`). Note `repoPath`
   alone is only the path _within_ the repo, so a file dropped at the storage
   root does **not** count as correctly placed. Mismatch → `Misplaced`.
6. All of size ✓, sha ✓, directory ✓ → `Pass`.

### Statuses

| Status              | Meaning                                                   |
| ------------------- | --------------------------------------------------------- |
| `Pass`              | size ✓ + sha256 ✓ + directory ✓                           |
| `Incomplete`        | on-disk size ≠ HF size, or missing shards (fail-fast)     |
| `Checksum mismatch` | size matched but computed sha256 ≠ HF sha256 (corruption) |
| `Misplaced`         | size/sha ok but path ≠ `<repoId>/<repoPath>`              |
| `Unverifiable`      | could not infer an HF repo containing the exact filename  |

## Fixing misplaced files

A `Misplaced` file has the right size and sha256 but sits at the wrong on-disk
path. It can be relocated into its HuggingFace layout (`<repoId>/<repoPath>`)
without re-downloading:

- **UI** — a per-row **Fix** button next to the `Misplaced` badge moves that
  row's misplaced file(s); a bulk **Fix misplaced (N)** button in the action bar
  moves every misplaced file from the run.
- **Endpoint** — `POST /api/v1/audit/fix { location, files }`. For each selected
  path the server re-infers the HF source and recomputes the target
  `<repoId>/<repoPath>`; it never trusts a client-supplied destination. It then
  renames the file (and its `.tjmeta.json` sidecar) into place, creating
  intermediate directories. It refuses to escape the storage root or overwrite an
  existing destination, and returns a per-file `{moved | skipped | error}` result.
- **Client state** — a moved file keeps its verified size/sha, so the UI marks it
  `Pass` and remaps the audit/selection state to the new path in place rather than
  re-hashing.

## Per-file sidecar metadata

Written next to each physical file (each shard of a split model gets its own),
named `<filename>.tjmeta.json`:

```json
{
  "modelUrl": "https://huggingface.co/<repoId>",
  "originUrl": "https://huggingface.co/<repoId>/blob/<branch>/<repoPath>",
  "sourceSha256": "<inferred HF sha256>",
  "computedSha256": "<computed sha256>"
}
```

- `modelUrl` — the inferred HF model/repo URL (e.g.
  `https://huggingface.co/unsloth/GLM-4.7-GGUF`).
- `originUrl` — the inferred HF file URL within the repo. Both URLs are derived
  from the filename inference, so they are best guesses until a future
  download-time flow records authoritative provenance.
- `sourceSha256` — cached from the inferred HF LFS oid during audit (per the
  approved decision to cache it).
- `computedSha256` — the local file's computed sha256.

Sidecars are written for any file that reaches the hashing step (size passed).
`*.tjmeta.json` files are ignored by the model scanner (they aren't model
extensions, so they are naturally excluded).

## Components

### Backend

- **`lib/hf-infer.ts`** (new)
  `inferHfFile(modelName, filename): Promise<{repoId, branch, repoPath, size, sha256} | null>`.
  Encapsulates the search → tree → exact-filename-match logic with a per-run cache.

- **`lib/audit.ts`** (new)
  - `readMeta(filePath)` / `writeMeta(filePath, meta)` — sidecar I/O.
  - `localSha256(fullPath)` — mirrors the existing `localMd5` helper, using `sha256sum`.
  - `auditFile(basePath, relPath, modelName, filename)` — orchestrates the algorithm
    above and returns `{ file, status, expected, actual }`.

- **`app/api/v1/audit/route.ts`** (new)
  `POST { location: 'local' | 'cold-storage' }`. Resolves the base path
  (`localModelsDir` or `coldStorageDir` from `lib/config`), scans it with
  `scanModels`, audits each file, and **streams NDJSON** per-file results so the
  UI shows progress during the slow hashing (same `TransformStream` streaming
  pattern as `app/api/v1/copy/route.ts`).

### Frontend (Astryx)

- **`components/audit/audit-view.tsx`** (new)
  The audit UI: an Astryx `Table`/`List` of the active location's files with a
  status `Badge` each, a **Run audit** `Button`, and live progress as NDJSON
  results stream in. Rendered in place of the models table when audit mode is on.

- **`components/home/home-client.tsx`** (edit)
  - `auditMode` boolean state.
  - An **Audit** toggle (Astryx `Switch`/`SegmentedControl`), shown only when
    `activeLocation !== 'all'`. For remote peer tabs the toggle is disabled with a
    "not yet supported" hint; it is active for the local peer and `cold-storage`.
  - When `auditMode` is on, render `<AuditView location=… />` instead of
    `<ModelsTableClient>`; the HF download UI stays hidden in audit mode.

## Data flow

```
User toggles Audit on a local/cold-storage tab
  → AuditView shows files, user clicks "Run audit"
  → POST /api/v1/audit { location }
       server: scanModels(basePath)
       for each file (streamed):
         inferHfFile() → size check → sha256 compute+compare → dir check
         write <file>.tjmeta.json
         emit NDJSON { file, status, expected, actual }
  → AuditView updates each row's badge as results arrive
```

## Error handling

- HF network/search failures for a file → `Unverifiable` for that file (audit of
  other files continues).
- `sha256sum` failure (unreadable file) → surfaced as an error status on that row;
  no sidecar written.
- Sidecar write failure → row shows the verdict but flags that metadata couldn't be
  persisted; does not abort the run.
- The stream reports per-file results independently so one bad file never fails the
  whole audit.

## Testing

- `lib/hf-infer.ts`: exact-filename match selection, "no match" → null, candidate
  ranking, cache behavior (mocked HF responses).
- `lib/audit.ts`: each status path (Pass / Incomplete / Checksum mismatch /
  Misplaced / Unverifiable), sidecar read/write round-trip, split-shard size
  aggregation, fail-fast skips hashing on size mismatch.
- `app/api/v1/audit/route.ts`: location → base-path resolution, NDJSON streaming
  shape, rejects unknown/remote locations.
- `components/audit/audit-view.tsx`: renders streamed statuses, Run button triggers
  the request, badge rendering per status.

## Risks

- **Inference reliability** — the weak link; mitigated by exact-filename matching and
  surfacing the inferred repo so the user can sanity-check. A manual repo override is
  a likely fast-follow.
- **Hashing cost** — multi-GB `sha256sum`; mitigated by on-demand triggering and
  streamed progress.
- **HF rate limits** — mitigated by per-run caching of search/tree responses.
