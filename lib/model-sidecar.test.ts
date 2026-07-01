import {test, expect} from 'bun:test';
import {
  mergeFileMeta,
  modelDirForRepo,
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
