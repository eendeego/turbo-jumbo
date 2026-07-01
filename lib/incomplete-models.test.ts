import {test, expect, afterEach} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  findIncompleteRepos,
  findReposWithInvalidFiles,
} from '@/lib/incomplete-models';

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

test('flags a whole-repo model that has a wrong-size file', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-inv-'));
  const repoId = 'invorg/kokoro-test';
  // A non-GGUF (whole-repo) model: a safetensors weight makes scanModels group
  // it, plus an index.json whose on-disk size (50) doesn't match HF (96).
  await writeSized(path.join(base, repoId, 'model.safetensors'), 20);
  await writeSized(path.join(base, repoId, 'index.json'), 50);
  mockTree(repoId, [
    {path: 'model.safetensors', size: 20},
    {path: 'index.json', size: 96},
  ]);

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

test('does not flag a pick-one ggml .bin repo (whisper.cpp) as incomplete', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-inc-'));
  const repoId = 'ggtest/whisper.cpp';
  // One variant downloaded; the repo offers many independent ggml-*.bin models.
  await writeSized(path.join(base, repoId, 'ggml-tiny.bin'), 10);
  mockTree(repoId, [
    {path: 'ggml-tiny.bin', size: 10},
    {path: 'ggml-base.bin', size: 20},
    {path: 'ggml-large-v3.bin', size: 30},
    {path: 'README.md', size: 1},
  ]);
  // Like GGUF, the other variants aren't "missing" — it's not incomplete.
  expect(await findIncompleteRepos(base)).toEqual([]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('still flags a whole-repo (onnx) model missing a file as incomplete', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-inc-'));
  const repoId = 'ktest/kokoro';
  await writeSized(path.join(base, repoId, 'voices-v1.0.bin'), 10); // have the .bin
  mockTree(repoId, [
    {path: 'voices-v1.0.bin', size: 10},
    {path: 'kokoro-v1.0.onnx', size: 99}, // missing locally
    {path: 'index.json', size: 5}, // missing locally
  ]);
  expect(await findIncompleteRepos(base)).toEqual([repoId]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('sees nested expected files via a recursive tree and flags a missing one', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-inc-'));
  const repoId = 'org/nested-vae';
  await writeSized(path.join(base, repoId, 'model.safetensors'), 10); // present
  // A root listing shows `split_files` as a directory; only a recursive listing
  // reveals the nested vae — so the fix is what surfaces it as missing.
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes(`/api/models/${repoId}/tree/main`)) {
      const files = u.includes('recursive=true')
        ? [
            {type: 'file', path: 'model.safetensors', size: 10},
            {type: 'file', path: 'split_files/vae/vae.safetensors', size: 20},
          ]
        : [
            {type: 'file', path: 'model.safetensors', size: 10},
            {type: 'directory', path: 'split_files'},
          ];
      return new Response(JSON.stringify(files), {status: 200});
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  expect(await findIncompleteRepos(base)).toEqual([repoId]);
  await fsp.rm(base, {recursive: true, force: true});
});
