import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {recordedSha256} from '@/lib/storage/recorded-digest';
import {MODEL_SIDECAR_NAME, type TjModel} from '@/lib/models/sidecar-types';

const SHA = 'f3668ba4cccf1ca6a7eb84e888fb92c1cdc7204d472ba9db771e6fd3abf6b874';
const REL = 'org/repo/model.safetensors';

// A model dir holding one file plus a sidecar describing it. `bytes` is what
// lands on disk; `recordedSize` is what the sidecar claims (they differ when a
// copy was truncated after the sidecar was written).
async function fixture(
  opts: {bytes?: string; recordedSize?: number; sha?: string} = {},
): Promise<string> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-digest-'));
  const bytes = opts.bytes ?? 'weights';
  await fsp.mkdir(path.join(base, 'org/repo'), {recursive: true});
  await fsp.writeFile(path.join(base, REL), bytes);
  const sidecar: TjModel = {
    modelUrl: 'https://huggingface.co/org/repo',
    repoId: 'org/repo',
    files: [
      {
        path: 'model.safetensors',
        originUrl:
          'https://huggingface.co/org/repo/blob/main/model.safetensors',
        sourceSize: bytes.length,
        computedSize: opts.recordedSize ?? bytes.length,
        sourceSha256: opts.sha ?? SHA,
        computedSha256: opts.sha ?? SHA,
      },
    ],
  };
  await fsp.writeFile(
    path.join(base, 'org/repo', MODEL_SIDECAR_NAME),
    JSON.stringify(sidecar),
  );
  return base;
}

test('returns the recorded hash when the file matches its sidecar', async () => {
  const base = await fixture();
  expect(await recordedSha256(base, REL)).toBe(SHA);
});

test('returns null when the recorded size disagrees with the file on disk', async () => {
  const base = await fixture({recordedSize: 999999});
  expect(await recordedSha256(base, REL)).toBeNull();
});

test('returns null when the file was modified after its sidecar', async () => {
  const base = await fixture();
  const future = new Date(Date.now() + 60_000);
  await fsp.utimes(path.join(base, REL), future, future);
  expect(await recordedSha256(base, REL)).toBeNull();
});

test('returns null when the sidecar recorded no hash', async () => {
  const base = await fixture({sha: ''});
  expect(await recordedSha256(base, REL)).toBeNull();
});

test('returns null when the model has no sidecar', async () => {
  const base = await fixture();
  await fsp.rm(path.join(base, 'org/repo', MODEL_SIDECAR_NAME));
  expect(await recordedSha256(base, REL)).toBeNull();
});

test('returns null when the file is missing', async () => {
  const base = await fixture();
  await fsp.rm(path.join(base, REL));
  expect(await recordedSha256(base, REL)).toBeNull();
});

test('returns null for a path escaping the base directory', async () => {
  const base = await fixture();
  expect(await recordedSha256(base, '../outside.safetensors')).toBeNull();
});
