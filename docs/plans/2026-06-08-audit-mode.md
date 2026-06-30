# Audit Mode Implementation Plan

**Goal:** Add an on-demand "audit mode" to every location tab except All that
verifies each file's size, SHA256, and directory placement against its
(filename-inferred) HuggingFace source.

**Architecture:** A new `lib/hf-infer.ts` infers the HF repo/file for a local
filename (HF search → tree exact-filename match) and returns its expected size +
sha256. A new `lib/audit.ts` holds the pure status-decision logic plus sidecar
I/O and a `sha256sum` helper. A streaming `POST /api/v1/audit` route scans a
local-or-cold-storage location and emits NDJSON per-file verdicts (same
`TransformStream` pattern as `app/api/v1/copy/route.ts`). A new
`components/audit/audit-view.tsx` renders the audit UI with Astryx components;
`components/home/home-client.tsx` gains an audit toggle gated to locally-reachable
tabs.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript (strict), Bun
(`bun test`), `sha256sum` CLI, HuggingFace public API, Astryx + StyleX.

**Source spec:** `docs/plans/2026-06-08-audit-mode-design.md`

**Conventions:** Commit with `jj commit -m "<message>"` (jujutsu, not git). After
each task run `bun typecheck`, `bun lint`, `bun format:check` (and `bun test`
where tests exist). The active location lives in the URL (see `lib/locations.ts`),
not component state.

---

## File structure

- **Create** `lib/hf-infer.ts` + `lib/hf-infer.test.ts` — infer HF source
  `{repoId, branch, repoPath, size, sha256}` from a filename, with a per-run cache.
- **Create** `lib/audit.ts` + `lib/audit.test.ts` — `AuditStatus`/`AuditResult`/
  `TjMeta` types, pure `decideStatus()`, `localSha256()`, sidecar
  `metaPath`/`readMeta`/`writeMeta`, and the `auditFile()` orchestrator.
- **Create** `app/api/v1/audit/route.ts` — streaming NDJSON audit endpoint.
- **Create** `components/audit/audit-view.tsx` — audit UI (Run button, streamed
  status rows as an Astryx `Table`/`List` with a status `Badge`).
- **Modify** `components/home/home-client.tsx` — audit toggle + conditional render.

---

## Task 1: `lib/hf-infer.ts` — infer HF source from filename

- Export `HfFileInfo {repoId, branch, repoPath, size, sha256}` and
  `inferHfFile(modelName, filename, branch='main')` plus a test-only
  `_clearHfCache()`.
- Search `…/api/models?search=<modelName>&filter=gguf&limit=10`; for each
  candidate fetch `…/api/models/<id>/tree/<branch>?recursive=true&expand=true`
  and pick the first repo whose tree contains a file whose basename **exactly**
  equals `filename`. Take `size`/`sha256` from `lfs` (strip a `sha256:` prefix
  from the oid); fall back to the plain entry `size`.
- No match in any candidate → `null`. Cache per filename for the run.
- Tests (mocked `fetch`): exact-match selection + size/sha parsing, no-match →
  null, `sha256:` prefix stripping.

## Task 2: `lib/audit.ts` — status logic, sidecar I/O, orchestrator

- `decideStatus({hf, actualSize, relPath, computedSha256})` — pure, fail-fast in
  spec order: `!hf` → `unverifiable`; size ≠ → `incomplete`; sha null →
  `error`; sha ≠ → `checksum-mismatch`; path ≠ `repoPath` → `misplaced`; else
  `pass`.
- `localSha256(fullPath)` via `execFile('sha256sum', …)`.
- `metaPath`/`readMeta`/`writeMeta` for the `<file>.tjmeta.json` sidecar
  (`{originUrl: '', sourceSha256, computedSha256}`; `originUrl` starts empty).
- `auditFile(basePath, relPath, modelName, filename)` — stat → infer → size
  fail-fast → hash → write sidecar (non-fatal on write failure) → `decideStatus`.
- Tests: every status path, sidecar round-trip + `metaPath` naming, `readMeta`
  returns null when absent.

## Task 3: `app/api/v1/audit/route.ts` — streaming audit endpoint

- `POST {location: 'local' | 'cold-storage'}`. Resolve `basePath` from
  `localModelsDir` / `coldStorageDir` (`lib/config`); reject anything else with 400.
- `scanModels(basePath)`, then for each file emit one NDJSON `AuditResult` via a
  `TransformStream` writer. Split models with missing shards fail fast at the
  model level (`incomplete`); otherwise audit each shard. Close the writer when
  done. `Content-Type: application/x-ndjson`.

## Task 4: `components/audit/audit-view.tsx` — audit UI

- Astryx-native. Props: `{location: 'local' | 'cold-storage'}`.
- A **Run audit** `Button` (label flips to "Auditing…" while running), an error
  `Banner`, and a `List`/`Table` of rows: filename + a status `Badge`
  (`pass` → success, `incomplete`/`checksum-mismatch`/`error` → error,
  `misplaced` → warning, `unverifiable` → neutral) plus any message.
- Stream the NDJSON response, appending each parsed `AuditResult` to state as it
  arrives. `import type {AuditResult, AuditStatus}` is type-only so the
  server-only `lib/audit.ts` is erased from the client bundle.

## Task 5: Wire the audit toggle into `components/home/home-client.tsx`

- `auditMode` boolean state; reset to false in the render-phase location reset.
- Derive `auditLocation: 'local' | 'cold-storage' | null` — `cold-storage` tab →
  `'cold-storage'`, local peer tab (`activeLocation === localPeerAddress`) →
  `'local'`, else `null`.
- Render an **Audit** toggle (Astryx `Button`/`Switch`) only when
  `activeLocation !== 'all'`; disabled with a "not yet supported for remote
  peers" hint when `auditLocation === null`.
- When `auditMode && auditLocation`, render `<AuditView location=… />` in place of
  the HF download UI + `<ModelsTableClient>`.

## Task 6: Manual smoke verification

- Toggle gating (none on All; enabled on local + cold-storage; disabled on remote
  peers), a streamed run producing per-file badges + `.tjmeta.json` sidecars,
  exit/reset behavior, and a final `bun test` / `typecheck` / `lint` /
  `format:check` pass.

---

## Self-review notes

- **Spec coverage:** infer-from-filename (Task 1) · size fail-fast + sha256 +
  directory checks and statuses (Task 2 `decideStatus`) · sidecar with
  `originUrl`/`sourceSha256`/`computedSha256`, source sha cached (Task 2
  `auditFile`) · on-demand streaming run, local + cold-storage only (Tasks 3, 5) ·
  per-tab-except-All toggle (Task 5) · split-model shard completeness (Task 3).
- **Type consistency:** `HfFileInfo`, `AuditStatus`, `AuditResult`, `TjMeta`,
  `inferHfFile`, `decideStatus`, `auditFile`, `metaPath`/`readMeta`/`writeMeta`,
  and the `{location}` request body are used identically across route, view, tests.
- **Known limitation (from spec):** filename→repo inference is unreliable; expect
  a real share of `Unverifiable`. A manual repo override is a deliberate non-goal.
