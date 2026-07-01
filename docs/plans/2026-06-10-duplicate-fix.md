# Duplicate Fix Action Implementation Plan

**Goal:** A Fix button on `duplicate` audit results that resolves the group
server-side — invalid copies discarded, the oldest of valid copies deleted,
identical copies consolidated — leaving one verified copy at its HF expected
path.

**Architecture:** New `lib/fix-duplicates.ts` implements the per-group
resolution (resolve source once, hash every copy, classify against latest +
historical revisions, pick survivor by newest pinned revision, delete losers
with sidecars, place survivor). A new thin route
`app/api/v1/audit/fix-duplicate/route.ts` recomputes groups server-side and
calls it. The popover in `components/models/models-table-client.tsx` gains a
Fix button on duplicate entries; `components/home/home-client.tsx` posts and
remaps audit state.

**Tech Stack:** Next.js 16 App Router, TypeScript (strict), `bun test` with
stubbed `globalThis.fetch`, Jujutsu (`jj`).

**Spec:** `docs/plans/2026-06-10-duplicate-fix-design.md`

---

### Task 1: `fixDuplicateGroup` in `lib/fix-duplicates.ts`

- Export `findHistoricalMatch` from `lib/audit.ts` (drop the `function` →
  `export async function` prefix) so the fix module can reuse it.
- New `lib/fix-duplicates.ts`:
  `DuplicateFixResult {file, status: 'kept'|'deleted'|'skipped'|'error', to?, message?}`
  and `fixDuplicateGroup(basePath, relPaths, modelName, filename, signal?)`.
- Algorithm: resolve the source once (try each copy's `resolveSource` until
  one hits — inference is identical per copy but the sidecar fallback isn't);
  no source → skip all with `unverifiable`. Stat + hash every copy; any hash
  failure → skip all (an unhashable copy can't be ruled in or out). Classify
  each distinct sha once via `findHistoricalMatch` against the latest
  revision or history; no valid copy → skip all with `no valid copy`. Pick
  the survivor among valid copies by newest pinned `commitDate`, tie → the
  copy already at `expectedRelPath`, tie → lexicographically first path.
  Delete every other copy plus its `.tjmeta.json` (per-copy `error` on
  failure, doesn't abort the group). Move the survivor to the expected path
  if needed and rewrite its sidecar directly from the pinned revision +
  freshly computed hash (not `refreshMetaSource`, which would trust a stale
  prior hash).
- Tests (`lib/fix-duplicates.test.ts`, stubbed `globalThis.fetch` in the
  `audit.test.ts` pattern): one valid + one invalid copy; two valid copies at
  different revisions (newer wins); identical copies with one already placed;
  identical copies with none placed (one moved, rest deleted); no valid copy
  (all skipped, untouched); unresolvable source (all skipped, untouched).

### Task 2: `POST /api/v1/audit/fix-duplicate`

- New route: same location→basePath mapping and `clearHfCache()` as the other
  audit routes. Scan the location, compute `duplicateBasenames`, and for each
  _group_ containing a requested path, call `fixDuplicateGroup` once (dedupe
  by basename so selecting two copies of one group doesn't run it twice).
  Results cover every copy in the group, requested or not, so the client can
  clean up state for unselected twins.

### Task 3: Fix button on duplicate entries in the failure popover

- In `AuditFailureContent`/`AuditCell`/`ModelsTableClient`
  (`components/models/models-table-client.tsx`): thread `onFixDuplicate` /
  `fixingDuplicate` through the same chain as `onFixMisplaced` / `fixing`.
  `canFixDuplicate = f.status === 'duplicate' && !f.cached && onFixDuplicate != null`;
  render a `Fix`/`Fixing…` button next to the existing misplaced-Fix button.

### Task 4: `onFixDuplicate` handler in home-client

- In `components/home/home-client.tsx`: `fixingDuplicate` state,
  `onFixDuplicate(paths)` posts to the new route and applies results —
  `deleted` drops the path from `auditResults`/`auditedPaths`/`selected`;
  `kept` remaps to `to ?? file` and marks `pass` (honest, since the fix just
  re-verified that copy's hash); `error` entries surface via the error
  banner. Then `refreshModels()`. Wire `onFixDuplicate`/`fixingDuplicate`
  into `<ModelsTableClient>`.

### Task 5: Final verification

- `bun test && bun typecheck && bun lint && bun format:check` all green.
