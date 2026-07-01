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
  removeFileMeta,
  summarizeModel,
  upsertFileMeta,
  writeModelSidecar,
  type TjModel,
  type TjModelFile,
} from '@/lib/model-sidecar';

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
