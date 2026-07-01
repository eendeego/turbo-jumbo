import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  mergeFileMeta,
  metaToEntry,
  modelDirForRepo,
  readFileMeta,
  readFileMetaByPath,
  readModelSidecar,
  removeFileMeta,
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
