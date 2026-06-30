import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  decideStatus,
  expectedRelPath,
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
