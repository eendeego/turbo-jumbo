# Copy Sidecar Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the copy flow moves a model file to any destination (peer or cold storage), its sidecar provenance travels with it and is merged into the destination's `tjmodel.json` (or legacy `.tjmeta.json` for stray files).

**Architecture:** A new `lib/copy-meta.ts` owns per-file meta read (source) and merge-apply (destination), built on the existing `readMetaResolved`/`updateMetaResolved` machinery. A new `POST /api/v1/local-models/file-meta` route receives meta on network legs. The five transfer legs in `/api/v1/copy`, `local-models/push`, `cold-storage/from-local`, and `cold-storage/to-local` call these hooks after each file's bytes land. Meta failures are best-effort: reported in the run's `errors`, never failing the byte copy.

**Tech Stack:** Bun, Next.js 16 App Router route handlers, `bun:test` (co-located tests in `lib/`), Jujutsu for commits.

**Spec:** `docs/superpowers/specs/2026-07-02-copy-sidecar-propagation-design.md`

## Global Constraints

- Package manager/runtime is Bun: `bun test`, `bun typecheck`, `bun lint`. Never node/npx.
- VCS is Jujutsu: `jj commit -m "<message>" <paths>` (scope commits to this feature's paths; the working copy holds an unrelated `lib/load-object.ts` that must stay uncommitted). No Co-Authored-By trailers.
- Provenance travels per file only; never copy `tjmodel.json` wholesale.
- `repoCommit`/`repoCommitDate` apply at the destination only when its sidecar records none.
- Meta propagation failures must not fail the byte copy; they surface in the existing per-run `errors` channels.
- No new fs imports in client code: `lib/copy-meta.ts` is server-only (fine — only routes import it).

---

### Task 1: `lib/copy-meta.ts` with tests

**Files:**
- Create: `lib/copy-meta.ts`
- Create: `lib/copy-meta.test.ts`

**Interfaces:**
- Consumes: `readMetaResolved`, `updateMeta`, `updateMetaResolved`, `TjMeta` from `@/lib/tjmeta`; `modelDirForRepo`, `readModelSidecar` from `@/lib/model-sidecar`; `repoIdFromModelUrl` from `@/lib/model-name`.
- Produces (used by Tasks 2–4):
  - `interface RepoHead {id: string; date?: string}`
  - `interface FileMetaPayload {meta: TjMeta; repoHead?: RepoHead}`
  - `readFileMetaWithRepoHead(srcBase: string, relPath: string): Promise<FileMetaPayload | null>`
  - `applyFileMeta(dstBase: string, relPath: string, meta: TjMeta, repoHead?: RepoHead): Promise<void>`
  - `propagateFileMeta(srcBase: string, dstBase: string, relPath: string): Promise<void>`
  - `sendFileMeta(peerAddr: string, relPath: string, payload: FileMetaPayload, signal?: AbortSignal): Promise<void>`

- [ ] **Step 1: Write the failing tests** — `lib/copy-meta.test.ts`:

```ts
import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  applyFileMeta,
  propagateFileMeta,
  readFileMetaWithRepoHead,
} from '@/lib/copy-meta';
import {
  readModelSidecar,
  writeModelSidecar,
  type TjModel,
  type TjModelFile,
} from '@/lib/model-sidecar';
import {readMeta, writeMeta, type TjMeta} from '@/lib/tjmeta';

const meta = (o: Partial<TjMeta> = {}): TjMeta => ({
  modelUrl: 'https://huggingface.co/org/repo',
  originUrl: 'https://huggingface.co/org/repo/blob/main/a.gguf',
  sourceSize: 3,
  computedSize: 3,
  sourceSha256: 'aaa',
  computedSha256: 'aaa',
  ...o,
});

const entry = (o: Partial<TjModelFile>): TjModelFile => ({
  path: 'a.gguf',
  originUrl: 'https://huggingface.co/org/repo/blob/main/a.gguf',
  sourceSize: 3,
  computedSize: 3,
  sourceSha256: 'aaa',
  computedSha256: 'aaa',
  ...o,
});

const model = (o: Partial<TjModel>): TjModel => ({
  modelUrl: 'https://huggingface.co/org/repo',
  repoId: 'org/repo',
  files: [],
  ...o,
});

async function tmpBases(): Promise<{root: string; src: string; dst: string}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-copymeta-'));
  const src = path.join(root, 'src');
  const dst = path.join(root, 'dst');
  await fsp.mkdir(src, {recursive: true});
  await fsp.mkdir(dst, {recursive: true});
  return {root, src, dst};
}

test('propagateFileMeta merges into the destination sidecar, keeping dest-only entries', async () => {
  const {root, src, dst} = await tmpBases();
  await writeModelSidecar(src, 'org/repo', model({files: [entry({})]}));
  await writeModelSidecar(
    dst,
    'org/repo',
    model({
      files: [
        entry({
          path: 'b.gguf',
          originUrl: 'https://huggingface.co/org/repo/blob/main/b.gguf',
        }),
      ],
    }),
  );

  await propagateFileMeta(src, dst, 'org/repo/a.gguf');

  const after = await readModelSidecar(dst, 'org/repo');
  expect(after?.files.map((f) => f.path).sort()).toEqual(['a.gguf', 'b.gguf']);
  expect(after?.files.find((f) => f.path === 'a.gguf')?.sourceSha256).toBe(
    'aaa',
  );
  await fsp.rm(root, {recursive: true, force: true});
});

test('propagateFileMeta falls back to a legacy sidecar for a stray file', async () => {
  const {root, src, dst} = await tmpBases();
  // A stray file at the storage root has no model dir; its provenance lives in
  // a legacy per-file sidecar and must arrive at the destination the same way.
  await writeMeta(
    path.join(src, 'stray.gguf'),
    meta({originUrl: 'https://huggingface.co/org/repo/blob/main/stray.gguf'}),
  );

  await propagateFileMeta(src, dst, 'stray.gguf');

  const after = await readMeta(path.join(dst, 'stray.gguf'));
  expect(after?.sourceSha256).toBe('aaa');
  expect(await readModelSidecar(dst, 'org/repo')).toBeNull();
  await fsp.rm(root, {recursive: true, force: true});
});

test('propagateFileMeta is a no-op when the source has no provenance', async () => {
  const {root, src, dst} = await tmpBases();
  await propagateFileMeta(src, dst, 'org/repo/a.gguf');
  expect(await readModelSidecar(dst, 'org/repo')).toBeNull();
  await fsp.rm(root, {recursive: true, force: true});
});

test('readFileMetaWithRepoHead carries the source model repoCommit', async () => {
  const {root, src} = await tmpBases();
  await writeModelSidecar(
    src,
    'org/repo',
    model({files: [entry({})], repoCommit: 'head1', repoCommitDate: 'd1'}),
  );

  const payload = await readFileMetaWithRepoHead(src, 'org/repo/a.gguf');
  expect(payload?.meta.sourceSha256).toBe('aaa');
  expect(payload?.repoHead).toEqual({id: 'head1', date: 'd1'});
  await fsp.rm(root, {recursive: true, force: true});
});

test('applyFileMeta sets repoCommit only when the destination has none', async () => {
  const {root, dst} = await tmpBases();
  // Fresh destination: the forwarded head lands.
  await applyFileMeta(dst, 'org/repo/a.gguf', meta(), {id: 'srchead'});
  expect((await readModelSidecar(dst, 'org/repo'))?.repoCommit).toBe(
    'srchead',
  );

  // Destination already has an observation: a copy must not clobber it.
  const dst2 = path.join(root, 'dst2');
  await writeModelSidecar(
    dst2,
    'org/repo',
    model({files: [], repoCommit: 'desthead'}),
  );
  await applyFileMeta(dst2, 'org/repo/a.gguf', meta(), {id: 'srchead'});
  expect((await readModelSidecar(dst2, 'org/repo'))?.repoCommit).toBe(
    'desthead',
  );
  await fsp.rm(root, {recursive: true, force: true});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/copy-meta.test.ts`
Expected: FAIL — module `@/lib/copy-meta` not found.

- [ ] **Step 3: Write the implementation** — `lib/copy-meta.ts`:

```ts
import path from 'path';
import {repoIdFromModelUrl} from '@/lib/model-name';
import {modelDirForRepo, readModelSidecar} from '@/lib/model-sidecar';
import {
  readMetaResolved,
  updateMeta,
  updateMetaResolved,
  type TjMeta,
} from '@/lib/tjmeta';

export interface RepoHead {
  id: string;
  date?: string;
}

/** A file's provenance plus its model's repo-level commit, ready to travel. */
export interface FileMetaPayload {
  meta: TjMeta;
  repoHead?: RepoHead;
}

/**
 * Source side of a copy: a file's provenance entry together with its model
 * sidecar's repo-level commit. Null when the file has no recorded provenance —
 * a copy never fabricates one.
 */
export async function readFileMetaWithRepoHead(
  srcBase: string,
  relPath: string,
): Promise<FileMetaPayload | null> {
  const meta = await readMetaResolved(srcBase, relPath);
  if (!meta) return null;
  const repoId = repoIdFromModelUrl(meta.modelUrl);
  const loc = repoId ? modelDirForRepo(relPath, repoId) : null;
  const model = loc ? await readModelSidecar(srcBase, loc.dir) : null;
  return {
    meta,
    ...(model?.repoCommit
      ? {
          repoHead: {
            id: model.repoCommit,
            ...(model.repoCommitDate ? {date: model.repoCommitDate} : {}),
          },
        }
      : {}),
  };
}

/**
 * Destination side of a copy: merge one file's provenance into this base's
 * sidecars (model sidecar when the file sits in a model dir, legacy per-file
 * sidecar otherwise). The forwarded `repoHead` applies only when the
 * destination sidecar records no repoCommit of its own — a copy is not a fresh
 * HF resolution and must not clobber a newer observation here.
 */
export async function applyFileMeta(
  dstBase: string,
  relPath: string,
  meta: TjMeta,
  repoHead?: RepoHead,
): Promise<void> {
  const repoId = repoIdFromModelUrl(meta.modelUrl);
  if (!repoId) {
    await updateMeta(path.join(dstBase, relPath), meta);
    return;
  }
  let head = repoHead;
  if (head) {
    const loc = modelDirForRepo(relPath, repoId);
    const dest = loc ? await readModelSidecar(dstBase, loc.dir) : null;
    if (dest?.repoCommit) head = undefined;
  }
  await updateMetaResolved(dstBase, relPath, repoId, meta, head);
}

/** Both sides at once, for legs where source and destination are local paths. */
export async function propagateFileMeta(
  srcBase: string,
  dstBase: string,
  relPath: string,
): Promise<void> {
  const payload = await readFileMetaWithRepoHead(srcBase, relPath);
  if (!payload) return;
  await applyFileMeta(dstBase, relPath, payload.meta, payload.repoHead);
}

/** Network leg: hand a file's provenance to the destination peer to apply. */
export async function sendFileMeta(
  peerAddr: string,
  relPath: string,
  payload: FileMetaPayload,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`http://${peerAddr}/api/v1/local-models/file-meta`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      path: relPath,
      meta: payload.meta,
      ...(payload.repoHead ? {repoHead: payload.repoHead} : {}),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/copy-meta.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
jj commit -m "Add copy-meta: per-file sidecar read/apply for transfers" lib/copy-meta.ts lib/copy-meta.test.ts
```

---

### Task 2: `POST /api/v1/local-models/file-meta` route

**Files:**
- Create: `app/api/v1/local-models/file-meta/route.ts`

**Interfaces:**
- Consumes: `applyFileMeta`, `RepoHead` from `@/lib/copy-meta` (Task 1); `localModelsDir` from `@/lib/config`; `isObject`, `readJsonBody` from `@/lib/request`; `TjMeta` from `@/lib/tjmeta`.
- Produces: the endpoint `sendFileMeta` (Task 1) targets. Body `{path: string, meta: TjMeta, repoHead?: {id: string, date?: string}}`, responds `{ok: true}`.

- [ ] **Step 1: Write the route**

```ts
import {applyFileMeta, type RepoHead} from '@/lib/copy-meta';
import {localModelsDir} from '@/lib/config';
import {isObject, readJsonBody} from '@/lib/request';
import type {TjMeta} from '@/lib/tjmeta';
import nodePath from 'path';

type FileMetaRequest = {
  path: string;
  meta: TjMeta;
  repoHead?: RepoHead;
};

function isTjMeta(v: unknown): v is TjMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.modelUrl === 'string' &&
    typeof m.originUrl === 'string' &&
    typeof m.sourceSize === 'number' &&
    typeof m.computedSize === 'number' &&
    typeof m.sourceSha256 === 'string' &&
    typeof m.computedSha256 === 'string'
  );
}

function isRepoHead(v: unknown): v is RepoHead {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.id === 'string' &&
    (h.date === undefined || typeof h.date === 'string')
  );
}

/**
 * Receive one copied file's provenance from the peer that sent its bytes and
 * merge it into this host's sidecars (see lib/copy-meta.ts). The counterpart
 * of `sendFileMeta`; the byte transfer itself goes through `upload`.
 */
export async function POST(req: Request) {
  if (!localModelsDir) return new Response('No local peer', {status: 400});
  const body = await readJsonBody<FileMetaRequest>(req, isObject);
  if (body instanceof Response) return body;
  const {path, meta, repoHead} = body;
  if (typeof path !== 'string' || !isTjMeta(meta))
    return new Response('Invalid body', {status: 400});
  if (repoHead !== undefined && !isRepoHead(repoHead))
    return new Response('Invalid repoHead', {status: 400});

  const base = nodePath.resolve(localModelsDir);
  const full = nodePath.resolve(base, path);
  if (!full.startsWith(base + nodePath.sep))
    return new Response('Invalid path', {status: 400});

  await applyFileMeta(base, path, meta, repoHead);
  return Response.json({ok: true});
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
jj commit -m "Add file-meta route: receive a copied file's provenance" app/api/v1/local-models/file-meta
```

---

### Task 3: Cold-storage legs (direct, no network hop)

**Files:**
- Modify: `app/api/v1/cold-storage/from-local/route.ts` (~line 153, after `succeeded.push(file)`)
- Modify: `app/api/v1/cold-storage/to-local/route.ts` (errors channel + hook after per-file pipeline, ~line 148)
- Modify: `app/api/v1/copy/route.ts` (final local↔cold branch after `streamCopyResumable`, ~line 539; cold→remote reader `errors` parsing, ~lines 304–315)

**Interfaces:**
- Consumes: `propagateFileMeta(srcBase, dstBase, relPath)` from Task 1.
- Produces: `to-local` NDJSON frames gain a cumulative `errors: string[]` field (previously absent); the copy route surfaces them as `cold→local → <dest>: <msg>`.

- [ ] **Step 1: from-local — propagate local → cold after each success**

In `app/api/v1/cold-storage/from-local/route.ts`, import at top:

```ts
import {propagateFileMeta} from '@/lib/copy-meta';
```

Change the per-file success block (currently `filesDone++; fileDone = fileTotal; succeeded.push(file); emit();`) to:

```ts
            filesDone++;
            fileDone = fileTotal;
            succeeded.push(file);
            try {
              await propagateFileMeta(localBase, coldBase, file);
            } catch (err) {
              errors.push(
                `${file}: meta: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            emit();
```

- [ ] **Step 2: to-local — errors channel + propagate cold → local**

In `app/api/v1/cold-storage/to-local/route.ts`, import at top:

```ts
import {propagateFileMeta} from '@/lib/copy-meta';
```

Add `const errors: string[] = [];` next to the other counters (`let filesDone = 0; …`), and include `errors` in the emitted frame JSON:

```ts
      const emit = () =>
        safeEnqueue(
          enc.encode(
            JSON.stringify({
              filesDone,
              filesTotal,
              fileDone,
              fileTotal,
              bytesDone,
              bytesTotal,
              errors,
            }) + '\n',
          ),
        );
```

Change the per-file success tail (currently `filesDone++; fileDone = fileTotal; emit();`) to:

```ts
          filesDone++;
          fileDone = fileTotal;
          try {
            await propagateFileMeta(coldBase, localBase, file);
          } catch (err) {
            errors.push(
              `${file}: meta: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          emit();
```

- [ ] **Step 3: copy route — local↔cold branch on this host**

In `app/api/v1/copy/route.ts`, import at top:

```ts
import {
  propagateFileMeta,
  readFileMetaWithRepoHead,
  sendFileMeta,
} from '@/lib/copy-meta';
```

(The `readFileMetaWithRepoHead`/`sendFileMeta` imports are used by Task 4; adding them here keeps one import edit.)

In the final branch (`if (srcIsCold || srcIsLocalPeer) { const srcBase = …; await streamCopyResumable(src, dst, {…}); }`), add after the `streamCopyResumable` call, inside the same `if` block:

```ts
                // Bytes are down; carry the file's provenance so the
                // destination names and audits it without a re-hash. Best
                // effort: a meta failure is reported but the copy stands.
                try {
                  await propagateFileMeta(srcBase, destBase, f.path);
                } catch (err) {
                  fail(
                    `meta ${source} → ${dest}: ${f.path}`,
                    err instanceof Error ? err.message : String(err),
                  );
                }
```

- [ ] **Step 4: copy route — surface to-local errors for cold → remote**

In the `destIsRemote && srcIsCold` branch's stream reader, extend the parsed frame type and capture errors (mirroring the `from-local` branch below it):

```ts
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            const baseBytesDone = bytesDone;
            const baseFilesDone = filesDone;
            let peerErrors: string[] = [];
            try {
              for (;;) {
                const {done, value} = await reader.read();
                if (done) break;
                buf += dec.decode(value, {stream: true});
                const lines = buf.split('\n');
                buf = lines.pop() ?? '';
                for (const line of lines) {
                  if (!line.trim()) continue;
                  const p = JSON.parse(line) as {
                    bytesDone: number;
                    filesDone: number;
                    errors?: string[];
                  };
                  fileDone = p.bytesDone;
                  bytesDone = baseBytesDone + p.bytesDone;
                  filesDone = baseFilesDone + p.filesDone;
                  if (p.errors) peerErrors = p.errors;
                  emit();
                }
              }
            } catch (err) {
              if (signal.aborted) throw err;
              fail(
                `cold→local → ${dest}`,
                err instanceof Error ? err.message : String(err),
              );
            }
            for (const e of peerErrors) {
              errors.push(`cold→local → ${dest}: ${e}`);
            }
            if (peerErrors.length > 0) emit();
            continue;
```

- [ ] **Step 5: Verify**

Run: `bun test && bun typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
jj commit -m "Propagate sidecar provenance on cold-storage copy legs" app/api/v1/cold-storage app/api/v1/copy/route.ts
```

---

### Task 4: Network legs (upload from this host, push between peers)

**Files:**
- Modify: `app/api/v1/copy/route.ts` (upload branch ~lines 327–381; push branch ~lines 233–264)
- Modify: `app/api/v1/local-models/push/route.ts`

**Interfaces:**
- Consumes: `readFileMetaWithRepoHead`, `sendFileMeta` from Task 1 (imports already added in Task 3); the `file-meta` route from Task 2.
- Produces: `push` response body becomes `{ok: true, metaErrors?: string[]}`; the copy route surfaces those as `push <source> → <dest>: <msg>`.

- [ ] **Step 1: copy route upload branch — send meta after the last chunk**

In the `destIsRemote && srcIsLocalPeer` branch, after the chunk loop (and the zero-size special case) but before `filesDone++`, insert its own try/catch so a meta failure doesn't count the byte upload as failed:

```ts
                // Bytes are up; hand the destination the file's provenance so
                // it names and audits the copy without a re-hash. Best effort:
                // failure is reported but the upload stands.
                try {
                  const payload = await readFileMetaWithRepoHead(
                    localBase,
                    f.path,
                  );
                  if (payload) await sendFileMeta(dest, f.path, payload, signal);
                } catch (err) {
                  if (signal.aborted) throw err;
                  fail(
                    `meta ${f.path} → ${dest}`,
                    err instanceof Error ? err.message : String(err),
                  );
                }
                filesDone++;
                fileDone = f.size;
                emit();
```

- [ ] **Step 2: push route — send meta per file, collect failures**

In `app/api/v1/local-models/push/route.ts`, import at top:

```ts
import {readFileMetaWithRepoHead, sendFileMeta} from '@/lib/copy-meta';
```

Add `const metaErrors: string[] = [];` before the `for (const file of files)` loop. Restructure the loop body so the empty-file case no longer `continue`s past the meta send — both sizes fall through to one meta block at the end:

```ts
  for (const file of files) {
    const full = nodePath.resolve(base, file);
    if (!full.startsWith(base + nodePath.sep))
      return new Response('Invalid path', {status: 400});

    const {size: fileSize} = await fsp.stat(full);
    const uploadUrl = `http://${toPeer}/api/v1/local-models/upload`;

    logger.info(`[push] upload ${file} → ${toPeer}`);
    if (fileSize === 0) {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {'x-file-path': file, 'x-chunk-offset': '0'},
      });
      if (!res.ok) {
        logger.error(
          `[push] upload failed for ${file} → ${toPeer}: ${res.status}`,
        );
        return new Response(`Upload to peer failed: ${await res.text()}`, {
          status: 502,
        });
      }
    } else {
      for (let offset = 0; offset < fileSize; offset += CHUNK_SIZE) {
        // … existing chunk loop, unchanged …
      }
    }

    // Bytes are up; hand the destination this file's provenance. Best effort:
    // a meta failure is reported to the caller but doesn't fail the push.
    try {
      const payload = await readFileMetaWithRepoHead(base, file);
      if (payload) await sendFileMeta(toPeer, file, payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[push] meta failed for ${file} → ${toPeer}: ${msg}`);
      metaErrors.push(`${file}: meta: ${msg}`);
    }
  }
```

And change the final response to:

```ts
  return Response.json({
    ok: true,
    ...(metaErrors.length ? {metaErrors} : {}),
  });
```

- [ ] **Step 3: copy route push branch — surface the push's metaErrors**

In the `!destIsCold && srcIsRemote` branch, after the `if (!res.ok) {…; continue;}` guard:

```ts
            const {metaErrors} = (await res
              .json()
              .catch(() => ({}) as {metaErrors?: string[]})) as {
              metaErrors?: string[];
            };
            for (const e of metaErrors ?? []) {
              errors.push(`push ${source} → ${dest}: ${e}`);
            }
            filesDone += groupFiles.length;
            bytesDone += pushBytes;
            fileDone = pushBytes;
            emit();
            continue;
```

- [ ] **Step 4: Verify**

Run: `bun test && bun typecheck && bun lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "Propagate sidecar provenance on peer upload and push legs" app/api/v1/copy/route.ts app/api/v1/local-models/push/route.ts
```

---

### Task 5: Full-suite verification and formatting

- [ ] **Step 1: Run everything**

Run: `bun test && bun typecheck && bun lint`
Expected: full suite green.

- [ ] **Step 2: Format only the changed files**

```bash
bunx prettier --write lib/copy-meta.ts lib/copy-meta.test.ts \
  app/api/v1/local-models/file-meta/route.ts \
  app/api/v1/local-models/push/route.ts \
  app/api/v1/cold-storage/from-local/route.ts \
  app/api/v1/cold-storage/to-local/route.ts \
  app/api/v1/copy/route.ts
```

(Not `bun format` — that reformats the whole repo.) If prettier changed anything, re-run `bun test` and amend into the working copy, then `jj commit` the formatting deltas with the plan/docs paths if any remain.

- [ ] **Step 3: Commit the plan document**

```bash
jj commit -m "Add implementation plan for copy sidecar propagation" docs/superpowers/plans/2026-07-02-copy-sidecar-propagation.md
```

**Not covered by automated tests (by design):** the two-peer network legs need two live instances; unit tests cover the shared read/apply core, and the route wiring is thin. Live verification against a real peer (my-server) would mutate real model storage and is left to the user.
