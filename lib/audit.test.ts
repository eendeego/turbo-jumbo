import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  cachedResultFromMeta,
  decideStatus,
  expectedRelPath,
  hfSummary,
  moveFileWithMeta,
  readMeta,
  writeMeta,
  metaPath,
} from '@/lib/audit';
import type {HfFileInfo} from '@/lib/hf-infer';

const hf: HfFileInfo = {
  repoId: 'o/r',
  branch: 'main',
  repoPath: 'M.Q4.gguf',
  size: 100,
  sha256: 'deadbeef',
};

// The expected on-disk layout mirrors HuggingFace: <repoId>/<repoPath>.
const placed = 'o/r/M.Q4.gguf';

test('pass when size, sha, and repoId/repoPath all match', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: placed,
      computedSha256: 'deadbeef',
    }),
  ).toBe('pass');
});

test('unverifiable when no hf match', () => {
  expect(
    decideStatus({
      hf: null,
      actualSize: 100,
      relPath: 'x',
      computedSha256: 'y',
    }),
  ).toBe('unverifiable');
});

test('incomplete on size mismatch (before sha is considered)', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 99,
      relPath: placed,
      computedSha256: 'deadbeef',
    }),
  ).toBe('incomplete');
});

test('checksum-mismatch when computed sha differs', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: placed,
      computedSha256: 'other',
    }),
  ).toBe('checksum-mismatch');
});

test('misplaced when a file sits at the storage root instead of <repoId>/<repoPath>', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: 'M.Q4.gguf',
      computedSha256: 'deadbeef',
    }),
  ).toBe('misplaced');
});

test('misplaced when the repo directory is wrong', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: 'other/M.Q4.gguf',
      computedSha256: 'deadbeef',
    }),
  ).toBe('misplaced');
});

test('error when sha could not be computed despite matching size', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: placed,
      computedSha256: null,
    }),
  ).toBe('error');
});

test('expectedRelPath joins repoId and repoPath', () => {
  expect(expectedRelPath(hf)).toBe('o/r/M.Q4.gguf');
});

const cachedMeta = {
  modelUrl: 'https://huggingface.co/o/r',
  originUrl: 'https://huggingface.co/o/r/blob/main/sub/M.Q4.gguf',
  sourceSha256: 'deadbeef',
  computedSha256: 'deadbeef',
};

test('cachedResultFromMeta: pass when shas match and path is correct', () => {
  const r = cachedResultFromMeta('o/r/sub/M.Q4.gguf', cachedMeta);
  expect(r).toEqual({
    file: 'o/r/sub/M.Q4.gguf',
    status: 'pass',
    cached: true,
    hf: {
      repoId: 'o/r',
      modelUrl: 'https://huggingface.co/o/r',
      fileUrl: 'https://huggingface.co/o/r/blob/main/sub/M.Q4.gguf',
      expectedSha256: 'deadbeef',
      expectedPath: 'o/r/sub/M.Q4.gguf',
    },
  });
});

test('cachedResultFromMeta: checksum-mismatch when cached shas differ', () => {
  const r = cachedResultFromMeta('o/r/sub/M.Q4.gguf', {
    ...cachedMeta,
    computedSha256: 'other',
  });
  expect(r.status).toBe('checksum-mismatch');
  expect(r.cached).toBe(true);
});

test('cachedResultFromMeta: misplaced when current path differs from expected', () => {
  const r = cachedResultFromMeta('M.Q4.gguf', cachedMeta);
  expect(r.status).toBe('misplaced');
  expect(r.message).toBe('expected path o/r/sub/M.Q4.gguf');
});

test('cachedResultFromMeta: unverifiable when the sidecar has no source sha', () => {
  const r = cachedResultFromMeta('M.Q4.gguf', {
    modelUrl: '',
    originUrl: '',
    sourceSha256: '',
    computedSha256: '',
  });
  expect(r.status).toBe('unverifiable');
  expect(r.hf).toBeUndefined();
});

test('hfSummary builds repo/file URLs and expected values', () => {
  expect(hfSummary(hf)).toEqual({
    repoId: 'o/r',
    modelUrl: 'https://huggingface.co/o/r',
    fileUrl: 'https://huggingface.co/o/r/blob/main/M.Q4.gguf',
    expectedSize: 100,
    expectedSha256: 'deadbeef',
    expectedPath: 'o/r/M.Q4.gguf',
  });
});

test('writeMeta/readMeta round-trip and metaPath naming', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-audit-'));
  const f = path.join(dir, 'M.Q4.gguf');
  await fsp.writeFile(f, 'x');
  const meta = {
    modelUrl: 'https://huggingface.co/o/r',
    originUrl: 'https://huggingface.co/o/r/blob/main/M.Q4.gguf',
    sourceSha256: 'deadbeef',
    computedSha256: 'deadbeef',
  };
  await writeMeta(f, meta);
  expect(metaPath(f)).toBe(`${f}.tjmeta.json`);
  expect(await readMeta(f)).toEqual(meta);
  await fsp.rm(dir, {recursive: true, force: true});
});

test('readMeta returns null when no sidecar exists', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-audit-'));
  expect(await readMeta(path.join(dir, 'nope.gguf'))).toBeNull();
  await fsp.rm(dir, {recursive: true, force: true});
});

const exists = (p: string) =>
  fsp
    .access(p)
    .then(() => true)
    .catch(() => false);

test('moveFileWithMeta relocates the file and its sidecar, creating dirs', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-move-'));
  const meta = {
    modelUrl: 'u',
    originUrl: 'o',
    sourceSha256: 's',
    computedSha256: 'c',
  };
  await fsp.writeFile(path.join(base, 'M.Q4.gguf'), 'data');
  await writeMeta(path.join(base, 'M.Q4.gguf'), meta);

  await moveFileWithMeta(base, 'M.Q4.gguf', 'o/r/M.Q4.gguf');

  expect(await fsp.readFile(path.join(base, 'o/r/M.Q4.gguf'), 'utf8')).toBe(
    'data',
  );
  expect(await readMeta(path.join(base, 'o/r/M.Q4.gguf'))).toEqual(meta);
  expect(await exists(path.join(base, 'M.Q4.gguf'))).toBe(false);
  expect(await readMeta(path.join(base, 'M.Q4.gguf'))).toBeNull();

  await fsp.rm(base, {recursive: true, force: true});
});

test('moveFileWithMeta refuses to overwrite an existing destination', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-move-'));
  await fsp.writeFile(path.join(base, 'M.Q4.gguf'), 'a');
  await fsp.mkdir(path.join(base, 'o/r'), {recursive: true});
  await fsp.writeFile(path.join(base, 'o/r/M.Q4.gguf'), 'b');

  await expect(
    moveFileWithMeta(base, 'M.Q4.gguf', 'o/r/M.Q4.gguf'),
  ).rejects.toThrow();
  // source is left untouched on refusal
  expect(await fsp.readFile(path.join(base, 'M.Q4.gguf'), 'utf8')).toBe('a');

  await fsp.rm(base, {recursive: true, force: true});
});

test('moveFileWithMeta works when there is no sidecar', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-move-'));
  await fsp.writeFile(path.join(base, 'M.Q4.gguf'), 'data');

  await moveFileWithMeta(base, 'M.Q4.gguf', 'sub/M.Q4.gguf');

  expect(await fsp.readFile(path.join(base, 'sub/M.Q4.gguf'), 'utf8')).toBe(
    'data',
  );
  await fsp.rm(base, {recursive: true, force: true});
});

test('moveFileWithMeta rejects a target that escapes the storage root', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-move-'));
  await fsp.writeFile(path.join(base, 'M.Q4.gguf'), 'data');

  await expect(
    moveFileWithMeta(base, 'M.Q4.gguf', '../escape.gguf'),
  ).rejects.toThrow();

  await fsp.rm(base, {recursive: true, force: true});
});
