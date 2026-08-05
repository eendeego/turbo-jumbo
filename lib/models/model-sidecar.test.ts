import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  MIXED_COMMIT,
  deriveModelCommit,
  mergeFileMeta,
  metaToEntry,
  modelDirForRepo,
  readFileMeta,
  readFileMetaByPath,
  readModelSidecar,
  modelRevision,
  modelFileScope,
  setModelRevision,
  removeFileMeta,
  fileProvenance,
  summarizeFiles,
  summarizeModel,
  upsertFileMeta,
  writeModelSidecar,
  type TjModel,
  type TjModelFile,
} from '@/lib/models/model-sidecar';

const entry = (o: Partial<TjModelFile>): TjModelFile => ({
  path: 'x.gguf',
  originUrl: 'https://huggingface.co/org/repo/blob/main/x.gguf',
  sourceSize: 0,
  computedSize: 0,
  sourceSha256: '',
  computedSha256: '',
  ...o,
});

const model = (o: Partial<TjModel>): TjModel => ({
  modelUrl: 'https://huggingface.co/org/repo',
  repoId: 'org/repo',
  files: [],
  ...o,
});

test('summarizeModel sums file count and source size', () => {
  const s = summarizeModel(
    model({
      files: [
        entry({path: 'a.gguf', sourceSize: 100}),
        entry({path: 'b.gguf', sourceSize: 250}),
      ],
    }),
  );
  expect(s.fileCount).toBe(2);
  expect(s.totalSourceSize).toBe(350);
  expect(s.repoId).toBe('org/repo');
  expect(s.modelUrl).toBe('https://huggingface.co/org/repo');
});

test('summarizeModel passes through commits and date', () => {
  const s = summarizeModel(
    model({
      sourceCommit: 'abc123',
      repoCommit: 'def456',
      repoCommitDate: '2026-06-12T00:00:00Z',
    }),
  );
  expect(s.sourceCommit).toBe('abc123');
  expect(s.repoCommit).toBe('def456');
  expect(s.repoCommitDate).toBe('2026-06-12T00:00:00Z');
});

test('summarizeModel keeps MIXED_COMMIT as the source commit', () => {
  const s = summarizeModel(model({sourceCommit: MIXED_COMMIT}));
  expect(s.sourceCommit).toBe(MIXED_COMMIT);
});

test('summarizeModel omits commit fields when absent', () => {
  const s = summarizeModel(model({}));
  expect(s.sourceCommit).toBeUndefined();
  expect(s.repoCommit).toBeUndefined();
  expect(s.repoCommitDate).toBeUndefined();
  expect(s.fileCount).toBe(0);
  expect(s.totalSourceSize).toBe(0);
});

test('fileProvenance copies the provenance fields and omits empties', () => {
  const p = fileProvenance(
    entry({
      path: 'a.gguf',
      originUrl: 'https://huggingface.co/org/repo/blob/main/a.gguf',
      sourceCommit: 'abc123',
      sourceSize: 100,
      computedSize: 100,
      sourceSha256: 'aa',
      computedSha256: 'aa',
    }),
  );
  expect(p).toEqual({
    originUrl: 'https://huggingface.co/org/repo/blob/main/a.gguf',
    sourceCommit: 'abc123',
    sourceSize: 100,
    computedSize: 100,
    sourceSha256: 'aa',
    computedSha256: 'aa',
  });
  expect('sourceCommitDate' in p).toBe(false);
  expect('missing' in p).toBe(false);
});

test('summarizeFiles derives a shared revision and totals', () => {
  const s = summarizeFiles('https://huggingface.co/org/repo', 'org/repo', [
    entry({path: 'a', sourceCommit: 'c1', sourceSize: 100}),
    entry({path: 'b', sourceCommit: 'c1', sourceSize: 250}),
  ]);
  expect(s.sourceCommit).toBe('c1');
  expect(s.fileCount).toBe(2);
  expect(s.totalSourceSize).toBe(350);
  expect(s.repoCommit).toBeUndefined();
  expect(s.modelUrl).toBe('https://huggingface.co/org/repo');
});

test('summarizeFiles marks a mixed revision', () => {
  const s = summarizeFiles('https://huggingface.co/org/repo', 'org/repo', [
    entry({path: 'a', sourceCommit: 'c1'}),
    entry({path: 'b', sourceCommit: 'c2'}),
  ]);
  expect(s.sourceCommit).toBe(MIXED_COMMIT);
});

test('modelDirForRepo maps a flat-layout file to its repo dir and key', () => {
  expect(
    modelDirForRepo('unsloth/GLM-4.7-GGUF/a/b.gguf', 'unsloth/GLM-4.7-GGUF'),
  ).toEqual({dir: 'unsloth/GLM-4.7-GGUF', key: 'a/b.gguf'});
});

test('modelDirForRepo maps a hub-cache file to the repo dir and in-repo key', () => {
  const rel = 'models--unsloth--GLM-4.7-GGUF/snapshots/abc123/x.gguf';
  expect(modelDirForRepo(rel, 'unsloth/GLM-4.7-GGUF')).toEqual({
    dir: 'models--unsloth--GLM-4.7-GGUF',
    key: 'x.gguf',
  });
});

test('modelDirForRepo handles a single-part repo id', () => {
  expect(modelDirForRepo('gpt2/model.safetensors', 'gpt2')).toEqual({
    dir: 'gpt2',
    key: 'model.safetensors',
  });
});

test('modelDirForRepo returns null when the file is not under its repo dir', () => {
  expect(modelDirForRepo('stray.gguf', 'unsloth/GLM-4.7-GGUF')).toBeNull();
});

test('mergeFileMeta keeps a prior computed hash when the size is unchanged', () => {
  const prev = entry({computedSize: 100, computedSha256: 'abc'});
  const next = entry({computedSize: 100, computedSha256: ''});
  expect(mergeFileMeta(prev, next).computedSha256).toBe('abc');
});

test('mergeFileMeta drops a stale computed hash when the size changed', () => {
  const prev = entry({computedSize: 100, computedSha256: 'abc'});
  const next = entry({computedSize: 200, computedSha256: ''});
  expect(mergeFileMeta(prev, next).computedSha256).toBe('');
});

test('mergeFileMeta takes the source block from next only when next resolved one', () => {
  const prev = entry({sourceSha256: 'old', sourceCommit: 'c1'});
  const next = entry({sourceSha256: '', sourceCommit: undefined});
  expect(mergeFileMeta(prev, next).sourceCommit).toBe('c1');
});

test('writeModelSidecar then readModelSidecar round-trips', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  const model: TjModel = {
    modelUrl: 'https://huggingface.co/org/repo',
    repoId: 'org/repo',
    files: [entry({path: 'a.gguf', computedSize: 10})],
  };
  await writeModelSidecar(base, 'org/repo', model);
  expect(await readModelSidecar(base, 'org/repo')).toEqual(model);
  await fsp.rm(base, {recursive: true, force: true});
});

test('readModelSidecar returns null when absent', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  expect(await readModelSidecar(base, 'org/repo')).toBeNull();
  await fsp.rm(base, {recursive: true, force: true});
});

test('upsertFileMeta inserts then merges entries, serialized under concurrency', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  await Promise.all([
    upsertFileMeta(
      base,
      'org/repo',
      'org/repo',
      entry({path: 'a.gguf', computedSize: 1}),
    ),
    upsertFileMeta(
      base,
      'org/repo',
      'org/repo',
      entry({path: 'b.gguf', computedSize: 2}),
    ),
  ]);
  const model = await readModelSidecar(base, 'org/repo');
  expect(model?.files.map((f) => f.path).sort()).toEqual(['a.gguf', 'b.gguf']);
  expect(model?.modelUrl).toBe('https://huggingface.co/org/repo');

  await upsertFileMeta(
    base,
    'org/repo',
    'org/repo',
    entry({path: 'a.gguf', computedSize: 1, computedSha256: 'h'}),
  );
  await upsertFileMeta(
    base,
    'org/repo',
    'org/repo',
    entry({path: 'a.gguf', computedSize: 1, computedSha256: ''}),
  );
  expect((await readFileMeta(base, 'org/repo', 'a.gguf'))?.computedSha256).toBe(
    'h',
  );
  await fsp.rm(base, {recursive: true, force: true});
});

test('readFileMeta returns the entry as a TjMeta with modelUrl, or null', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  await upsertFileMeta(
    base,
    'org/repo',
    'org/repo',
    entry({path: 'a.gguf', sourceCommit: 'c'}),
  );
  const meta = await readFileMeta(base, 'org/repo', 'a.gguf');
  expect(meta?.modelUrl).toBe('https://huggingface.co/org/repo');
  expect(meta?.sourceCommit).toBe('c');
  expect(await readFileMeta(base, 'org/repo', 'missing.gguf')).toBeNull();
  await fsp.rm(base, {recursive: true, force: true});
});

test('metaToEntry drops modelUrl and sets the path key', () => {
  const e = metaToEntry('a.gguf', {
    modelUrl: 'https://huggingface.co/org/repo',
    originUrl: 'https://huggingface.co/org/repo/blob/main/a.gguf',
    sourceCommit: 'c',
    sourceSize: 5,
    computedSize: 5,
    sourceSha256: 's',
    computedSha256: 's',
  });
  expect(e).toEqual({
    path: 'a.gguf',
    originUrl: 'https://huggingface.co/org/repo/blob/main/a.gguf',
    sourceCommit: 'c',
    sourceSize: 5,
    computedSize: 5,
    sourceSha256: 's',
    computedSha256: 's',
  });
});

test('readFileMetaByPath finds a flat file via its model dir, walking up', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  await upsertFileMeta(
    base,
    'org/repo',
    'org/repo',
    entry({path: 'sub/a.gguf', sourceCommit: 'c'}),
  );
  const meta = await readFileMetaByPath(base, 'org/repo/sub/a.gguf');
  expect(meta?.sourceCommit).toBe('c');
  expect(meta?.modelUrl).toBe('https://huggingface.co/org/repo');
  await fsp.rm(base, {recursive: true, force: true});
});

test('readFileMetaByPath finds a hub-cache file by its in-repo key', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  await upsertFileMeta(
    base,
    'models--org--repo',
    'org/repo',
    entry({path: 'a.gguf', sourceCommit: 'r'}),
  );
  const rel = 'models--org--repo/snapshots/abc/a.gguf';
  expect((await readFileMetaByPath(base, rel))?.sourceCommit).toBe('r');
  await fsp.rm(base, {recursive: true, force: true});
});

test('readFileMetaByPath returns null when no model sidecar is found', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  expect(await readFileMetaByPath(base, 'org/repo/a.gguf')).toBeNull();
  await fsp.rm(base, {recursive: true, force: true});
});

test('removeFileMeta drops one entry, deleting the sidecar when it empties', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  await upsertFileMeta(base, 'org/repo', 'org/repo', entry({path: 'a.gguf'}));
  await upsertFileMeta(base, 'org/repo', 'org/repo', entry({path: 'b.gguf'}));
  await removeFileMeta(base, 'org/repo', 'a.gguf');
  expect(
    (await readModelSidecar(base, 'org/repo'))?.files.map((f) => f.path),
  ).toEqual(['b.gguf']);
  await removeFileMeta(base, 'org/repo', 'b.gguf');
  expect(await readModelSidecar(base, 'org/repo')).toBeNull();
  await fsp.rm(base, {recursive: true, force: true});
});

test('upsertFileMeta records a model-level repoCommit/date when repoHead is given', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  await upsertFileMeta(base, 'org/repo', 'org/repo', entry({path: 'a.gguf'}), {
    id: '047e0663',
    date: '2026-01-04T15:37:54.000Z',
  });
  const model = await readModelSidecar(base, 'org/repo');
  expect(model?.repoCommit).toBe('047e0663');
  expect(model?.repoCommitDate).toBe('2026-01-04T15:37:54.000Z');
  await fsp.rm(base, {recursive: true, force: true});
});

test('upsertFileMeta preserves an existing repoCommit when later upserts omit repoHead', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  await upsertFileMeta(base, 'org/repo', 'org/repo', entry({path: 'a.gguf'}), {
    id: '047e0663',
  });
  // A later write with no repoHead (a move or legacy migration) must not wipe it.
  await upsertFileMeta(base, 'org/repo', 'org/repo', entry({path: 'b.gguf'}));
  const model = await readModelSidecar(base, 'org/repo');
  expect(model?.repoCommit).toBe('047e0663');
  expect(model?.files.map((f) => f.path)).toEqual(['a.gguf', 'b.gguf']);
  await fsp.rm(base, {recursive: true, force: true});
});

test('deriveModelCommit returns the shared commit when all files agree', () => {
  expect(
    deriveModelCommit([
      entry({path: 'a', sourceCommit: 'abc'}),
      entry({path: 'b', sourceCommit: 'abc'}),
    ]),
  ).toBe('abc');
});

test('deriveModelCommit returns MIXED_COMMIT when commits differ', () => {
  expect(
    deriveModelCommit([
      entry({path: 'a', sourceCommit: 'abc'}),
      entry({path: 'b', sourceCommit: 'def'}),
    ]),
  ).toBe(MIXED_COMMIT);
});

test('deriveModelCommit returns MIXED_COMMIT when a file is missing a commit', () => {
  expect(
    deriveModelCommit([
      entry({path: 'a', sourceCommit: 'abc'}),
      entry({path: 'b'}),
    ]),
  ).toBe(MIXED_COMMIT);
});

test('deriveModelCommit is undefined when no file has a commit', () => {
  expect(
    deriveModelCommit([entry({path: 'a'}), entry({path: 'b'})]),
  ).toBeUndefined();
});

test('upsertFileMeta derives the model sourceCommit from its files', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-ms-'));
  await upsertFileMeta(
    base,
    'org/repo',
    'org/repo',
    entry({path: 'a', sourceCommit: 'abc'}),
  );
  expect((await readModelSidecar(base, 'org/repo'))?.sourceCommit).toBe('abc');
  await upsertFileMeta(
    base,
    'org/repo',
    'org/repo',
    entry({path: 'b', sourceCommit: 'def'}),
  );
  expect((await readModelSidecar(base, 'org/repo'))?.sourceCommit).toBe(
    MIXED_COMMIT,
  );
  await fsp.rm(base, {recursive: true, force: true});
});

test('modelRevision defaults to main and setModelRevision round-trips a pin', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-sidecar-'));
  const repoId = 'FastFlowLM/Gemma3-1B-NPU2';
  // No sidecar yet: main.
  expect(await modelRevision(base, repoId)).toBe('main');

  // Setting a pin creates the sidecar and round-trips.
  await setModelRevision(base, repoId, repoId, 'v0.9.20-faster-q4-1');
  expect(await modelRevision(base, repoId)).toBe('v0.9.20-faster-q4-1');
  expect((await readModelSidecar(base, repoId))?.repoId).toBe(repoId);

  // Re-downloading from main clears the pin (absent = main), keeping the file.
  await setModelRevision(base, repoId, repoId, 'main');
  expect(await modelRevision(base, repoId)).toBe('main');
  expect((await readModelSidecar(base, repoId))?.revision).toBeUndefined();
  await fsp.rm(base, {recursive: true, force: true});
});

test('modelRevision refuses a revision unsafe for URL interpolation', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-sidecar-'));
  const repoId = 'org/repo';
  const model: TjModel = {
    modelUrl: `https://huggingface.co/${repoId}`,
    repoId,
    revision: 'evil?x=1#frag',
    files: [],
  };
  await writeModelSidecar(base, repoId, model);
  expect(await modelRevision(base, repoId)).toBe('main');
  await fsp.rm(base, {recursive: true, force: true});
});

test('setModelRevision records a file scope and clears it when absent', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-sidecar-'));
  const repoId = 'FastFlowLM/scoped';
  await setModelRevision(base, repoId, repoId, 'v1-tag', [
    'config.json',
    'model.q4nx',
  ]);
  expect(await modelFileScope(base, repoId)).toEqual(
    new Set(['config.json', 'model.q4nx']),
  );
  // A later unscoped download clears the scope.
  await setModelRevision(base, repoId, repoId, 'main');
  expect(await modelFileScope(base, repoId)).toBeNull();
  await fsp.rm(base, {recursive: true, force: true});
});

test('removing the last file entry keeps a pinned/scoped sidecar alive', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-sidecar-'));
  const repoId = 'FastFlowLM/pinned';
  await setModelRevision(base, repoId, repoId, 'v1-tag', ['a.q4nx', 'b.json']);
  await upsertFileMeta(
    base,
    repoId,
    repoId,
    entry({
      path: 'b.json',
      originUrl: 'https://huggingface.co/x/blob/v1-tag/b.json',
    }),
  );
  await removeFileMeta(base, repoId, 'b.json');
  // No file entries remain, but the pin and scope survive.
  const sidecar = await readModelSidecar(base, repoId);
  expect(sidecar?.files).toEqual([]);
  expect(sidecar?.revision).toBe('v1-tag');
  expect(await modelFileScope(base, repoId)).toEqual(
    new Set(['a.q4nx', 'b.json']),
  );

  // An unpinned sidecar still disappears with its last entry.
  const plain = 'org/plain';
  await upsertFileMeta(base, plain, plain, entry({path: 'x.gguf'}));
  await removeFileMeta(base, plain, 'x.gguf');
  expect(await readModelSidecar(base, plain)).toBeNull();
  await fsp.rm(base, {recursive: true, force: true});
});

test('a pinned partial re-download keeps the recorded file scope', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-sidecar-'));
  const repoId = 'FastFlowLM/keep-scope';
  await setModelRevision(base, repoId, repoId, 'v1-tag', ['a.q4nx', 'b.json']);
  // A later pinned download without an explicit scope (the audit's partial
  // "Download missing files") must not widen the model to the whole tree.
  await setModelRevision(base, repoId, repoId, 'v1-tag');
  expect(await modelFileScope(base, repoId)).toEqual(
    new Set(['a.q4nx', 'b.json']),
  );
  await fsp.rm(base, {recursive: true, force: true});
});
