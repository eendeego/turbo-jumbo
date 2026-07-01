# Incremental sidecar updates during audits

**Date:** 2026-06-12
**Status:** Implemented

## Problem

`auditFile` writes the `.tjmeta.json` sidecar exactly once, at the very end of
an audit. Two consequences:

1. **Information learned mid-audit is lost on interruption.** The slow part of
   an audit is hashing a multi-GB file; a crash, server restart, or thrown
   network error during that window discards everything already established —
   the resolved HF source, the observed on-disk size.
2. **Information can be destroyed, not just lost.** The final write overwrites
   unconditionally: when this run fails to resolve a source (network error, repo
   gone) but a prior sidecar carried one — including a source set by hand via
   set-source — the source fields are blanked. `resolveSource`'s sidecar
   fallback only survives when the re-resolution itself succeeds.

Requirement (from the user): _when running an audit, update the sidecar file
whenever we have more information for it_ — and, implicitly, never replace
known information with less.

## Approaches considered

- **A. Incremental merge-writes inside `auditFile` (chosen).** A pure
  `mergeMeta(prev, next)` plus an `updateMeta` read-merge-write helper. Write
  the sidecar as soon as the source is resolved (before the expensive hash),
  and make the final write merge-aware. Minimal surface change; the sidecar
  format and all readers stay as they are.
- **B. Append-only observation journal, sidecar derived from it.** Strictly
  more durable, but a new on-disk format, migration concerns, and every reader
  (`cachedResultFromMeta`, fix flows, models scan) would need updating. YAGNI.
- **C. Merge-aware final write only.** Fixes destruction (problem 2) but not
  loss (problem 1): an audit that dies mid-hash still persists nothing. Fails
  the actual requirement.

## Design

### Merge semantics (`mergeMeta(prev: TjMeta | null, next: TjMeta): TjMeta`)

The sidecar has two logical blocks that move atomically:

- **Source block** (`modelUrl`, `originUrl`, `sourceCommit`,
  `sourceCommitDate`, `sourceSize`, `sourceSha256`): taken wholesale from
  `next` when this run resolved a source (`next.sourceSha256` non-empty),
  otherwise preserved wholesale from `prev`. Wholesale, because mixing fields
  from two different resolutions (e.g. a new sha with an old commit pin) would
  fabricate a revision that never existed.
- **Computed block**: `computedSize` is always the freshly observed size.
  `computedSha256` is the freshly computed hash when one exists; otherwise the
  prior hash carries over only when `prev.computedSize` equals the current
  size (same-size ⇒ presumed same bytes, the same presumption
  `refreshMetaSource` already makes); otherwise `''`.

`updateMeta(fullPath, next)` = `writeMeta(fullPath, mergeMeta(await
readMeta(fullPath), next))`.

### Write points in `auditFile`

1. **After source resolution, before any hashing.** Persists the source block
   and `computedSize`. Failure is swallowed (best-effort; the final write
   still reports `metadata write failed`). This is the write that makes an
   interrupted audit recoverable: the next run's `resolveSource` sidecar
   fallback finds the source without re-inference.
2. **The existing final write, now via `updateMeta`.** Same position and
   error-reporting as before; the merge keeps a prior source alive when this
   run came up unverifiable.

Intermediate hash-progress events do **not** trigger writes — only completed
facts do.

### Cached-verdict consistency

An interrupted audit can now leave a sidecar with a source but no computed
hash. `cachedResultFromMeta` previously had only one reading for
`computedSha256 !== sourceSha256`: `checksum-mismatch`. An empty
`computedSha256` is not a mismatch — the comparison never happened (this was
already latently true for the hash-failure path). New rule, checked after the
size check: empty `computedSha256` with a source present ⇒ `unverifiable`
with message `not hashed`.

### Out of scope

- `fixDuplicates`' sidecar write stays a plain `writeMeta`: it writes a
  complete, freshly computed record by construction.
- `refreshMetaSource` keeps its own logic (it falls back to hashing, which
  `mergeMeta` deliberately doesn't).

## Testing

Unit tests for `mergeMeta` (source block wholesale either way, hash carry-over
only on size match), `updateMeta` round-trip, the new `cachedResultFromMeta`
rule, and two `auditFile`-level behaviors: the sidecar already carries the
resolved source if hashing never completes (abort mid-hash), and a prior
hand-set source survives a run whose resolution fails.
