import {test, expect, afterEach} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {repoFileStatuses} from '@/lib/repo-files';
import {MODEL_SIDECAR_NAME, type TjModel} from '@/lib/model-sidecar';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Serve a fixed HF tree for one repo; everything else 404s.
function mockTree(repoId: string, files: Array<{path: string; size: number}>) {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes(`/api/models/${repoId}/tree/main`)) {
      return new Response(
        JSON.stringify(files.map((f) => ({type: 'file', ...f}))),
        {status: 200},
      );
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;
}

async function writeFileOfSize(full: string, size: number) {
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, Buffer.alloc(size, 'x'));
}

test('a checksum-less file with an unknown source size is valid when its size matches HF', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-rf-'));
  const repoId = 'rf/unknown-size';
  // index.json: a non-LFS file HF serves no checksum for — audit leaves its
  // source size unknown (0). It matches the HF tree size (96), so it validates
  // by size alone, not flagged invalid for being unattestable.
  mockTree(repoId, [{path: 'index.json', size: 96}]);
  await writeFileOfSize(path.join(base, repoId, 'index.json'), 96);

  const model: TjModel = {
    modelUrl: `https://huggingface.co/${repoId}`,
    repoId,
    files: [
      {
        path: 'index.json',
        originUrl: `https://huggingface.co/${repoId}/blob/main/index.json`,
        sourceSize: 0, // unknown — source never resolved
        computedSize: 96,
        sourceSha256: '',
        computedSha256: '',
      },
    ],
  };
  await fsp.writeFile(
    path.join(base, repoId, MODEL_SIDECAR_NAME),
    JSON.stringify(model),
  );

  const out = await repoFileStatuses(base, repoId);
  expect(out.find((f) => f.path === 'index.json')?.state).toBe('present');
  await fsp.rm(base, {recursive: true, force: true});
});

test('a checksum-less file whose size differs from HF is invalid', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-rf-'));
  const repoId = 'rf/wrong-size';
  // Same unattestable sidecar, but the on-disk size (50) doesn't match HF (96):
  // the size check alone condemns it.
  mockTree(repoId, [{path: 'index.json', size: 96}]);
  await writeFileOfSize(path.join(base, repoId, 'index.json'), 50);

  const model: TjModel = {
    modelUrl: `https://huggingface.co/${repoId}`,
    repoId,
    files: [
      {
        path: 'index.json',
        originUrl: `https://huggingface.co/${repoId}/blob/main/index.json`,
        sourceSize: 0,
        computedSize: 50,
        sourceSha256: '',
        computedSha256: '',
      },
    ],
  };
  await fsp.writeFile(
    path.join(base, repoId, MODEL_SIDECAR_NAME),
    JSON.stringify(model),
  );

  const out = await repoFileStatuses(base, repoId);
  expect(out.find((f) => f.path === 'index.json')?.state).toBe('invalid');
  await fsp.rm(base, {recursive: true, force: true});
});

test('a fully-attested sidecar (known matching size) stays present', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-rf-'));
  const repoId = 'rf/attested';
  mockTree(repoId, [{path: 'model.bin', size: 1000}]);
  await writeFileOfSize(path.join(base, repoId, 'model.bin'), 1000);

  const model: TjModel = {
    modelUrl: `https://huggingface.co/${repoId}`,
    repoId,
    files: [
      {
        path: 'model.bin',
        originUrl: `https://huggingface.co/${repoId}/blob/main/model.bin`,
        sourceSize: 1000,
        computedSize: 1000,
        sourceSha256: 'abc',
        computedSha256: 'abc',
      },
    ],
  };
  await fsp.writeFile(
    path.join(base, repoId, MODEL_SIDECAR_NAME),
    JSON.stringify(model),
  );

  const out = await repoFileStatuses(base, repoId);
  expect(out.find((f) => f.path === 'model.bin')?.state).toBe('present');
  await fsp.rm(base, {recursive: true, force: true});
});

test('a file with no sidecar entry stays present when its size matches HF', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-rf-'));
  const repoId = 'rf/no-entry';
  mockTree(repoId, [{path: 'README.md', size: 10}]);
  await writeFileOfSize(path.join(base, repoId, 'README.md'), 10);
  // No tjmodel.json at all — the unknown-size rule is scoped to recorded
  // metadata, so an unrecorded file is judged on size alone.

  const out = await repoFileStatuses(base, repoId);
  expect(out.find((f) => f.path === 'README.md')?.state).toBe('present');
  await fsp.rm(base, {recursive: true, force: true});
});

test('a size mismatch against HF is invalid regardless of any sidecar', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-rf-'));
  const repoId = 'rf/mismatch';
  mockTree(repoId, [{path: 'partial.bin', size: 1000}]);
  await writeFileOfSize(path.join(base, repoId, 'partial.bin'), 400); // truncated

  const out = await repoFileStatuses(base, repoId);
  expect(out.find((f) => f.path === 'partial.bin')?.state).toBe('invalid');
  await fsp.rm(base, {recursive: true, force: true});
});
