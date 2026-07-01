import {test, expect, afterEach} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {findReposWithInvalidFiles} from '@/lib/incomplete-models';
import {MODEL_SIDECAR_NAME, type TjModel} from '@/lib/model-sidecar';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

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

async function writeSized(full: string, size: number) {
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, Buffer.alloc(size, 'x'));
}

test('flags a whole-repo model that has an invalid file (unknown source size)', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-inv-'));
  const repoId = 'invorg/kokoro-test';
  // A non-GGUF (whole-repo) model: a safetensors weight makes scanModels group
  // it, plus an index.json whose sidecar can't attest it (unknown source size).
  await writeSized(path.join(base, repoId, 'model.safetensors'), 20);
  await writeSized(path.join(base, repoId, 'index.json'), 96);
  mockTree(repoId, [
    {path: 'model.safetensors', size: 20},
    {path: 'index.json', size: 96},
  ]);
  const model: TjModel = {
    modelUrl: `https://huggingface.co/${repoId}`,
    repoId,
    files: [
      {
        path: 'index.json',
        originUrl: `https://huggingface.co/${repoId}/blob/main/index.json`,
        sourceSize: 0, // unknown — never resolved → invalid
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

  expect(await findReposWithInvalidFiles(base)).toEqual([repoId]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('does not flag a whole-repo model whose files are all valid', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-inv-'));
  const repoId = 'valorg/clean';
  await writeSized(path.join(base, repoId, 'model.safetensors'), 20);
  mockTree(repoId, [{path: 'model.safetensors', size: 20}]);
  // No sidecar entry → judged on size alone, which matches → present.

  expect(await findReposWithInvalidFiles(base)).toEqual([]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('skips a self-contained GGUF repo even if a file looks off', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-inv-'));
  const repoId = 'ggufy/repo-GGUF';
  // A pure-GGUF repo is excluded before any tree fetch (per-quant audited).
  await writeSized(path.join(base, repoId, 'model-Q4_K_M.gguf'), 10);

  expect(await findReposWithInvalidFiles(base)).toEqual([]);
  await fsp.rm(base, {recursive: true, force: true});
});
