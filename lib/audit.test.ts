import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {decideStatus, readMeta, writeMeta, metaPath} from '@/lib/audit';
import type {HfFileInfo} from '@/lib/hf-infer';

const hf: HfFileInfo = {
  repoId: 'o/r',
  branch: 'main',
  repoPath: 'M.Q4.gguf',
  size: 100,
  sha256: 'deadbeef',
};

test('pass when size, sha, and path all match', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: 'M.Q4.gguf',
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
      relPath: 'M.Q4.gguf',
      computedSha256: 'deadbeef',
    }),
  ).toBe('incomplete');
});

test('checksum-mismatch when computed sha differs', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: 'M.Q4.gguf',
      computedSha256: 'other',
    }),
  ).toBe('checksum-mismatch');
});

test('misplaced when path differs but size and sha match', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: 'sub/M.Q4.gguf',
      computedSha256: 'deadbeef',
    }),
  ).toBe('misplaced');
});

test('error when sha could not be computed despite matching size', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: 'M.Q4.gguf',
      computedSha256: null,
    }),
  ).toBe('error');
});

test('writeMeta/readMeta round-trip and metaPath naming', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-audit-'));
  const f = path.join(dir, 'M.Q4.gguf');
  await fsp.writeFile(f, 'x');
  const meta = {
    originUrl: '',
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
