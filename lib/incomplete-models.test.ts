import {test, expect, afterEach} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  findIncompleteRepos,
  findReposWithInvalidFiles,
  detectMissingExpectedFiles,
} from '@/lib/incomplete-models';
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

test('does not flag a Comfy split_files safetensors bundle as incomplete', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-inc-'));
  const repoId = 'Comfy-Org/vae-text-encorder-for-flux-klein-9b';
  // Only the VAE downloaded; the text-encoder quants are independent variants.
  await writeSized(
    path.join(base, repoId, 'split_files/vae/flux2-vae.safetensors'),
    200,
  );
  mockTree(repoId, [
    {path: '.gitattributes', size: 5},
    {path: 'split_files/vae/flux2-vae.safetensors', size: 200},
    {path: 'split_files/text_encoders/qwen_3_8b.safetensors', size: 800},
    {
      path: 'split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors',
      size: 400,
    },
  ]);
  expect(await findIncompleteRepos(base)).toEqual([]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('does not flag a diffusers pipeline with a partial download as incomplete', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-inc-'));
  const repoId = 'stabilityai/sdxl-turbo';
  // Only the fp16 unet is present; the rest of the pipeline isn't "missing".
  await writeSized(
    path.join(base, repoId, 'unet/diffusion_pytorch_model.fp16.safetensors'),
    50,
  );
  mockTree(repoId, [
    {path: 'model_index.json', size: 6},
    {path: 'unet/diffusion_pytorch_model.fp16.safetensors', size: 50},
    {path: 'unet/diffusion_pytorch_model.safetensors', size: 100},
    {path: 'vae/diffusion_pytorch_model.fp16.safetensors', size: 16},
  ]);
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

// A tree mock that carries LFS oids, so listRepoFiles (which drops checksum-less
// entries) returns the weight paths.
function mockTreeLfs(
  repoId: string,
  files: Array<{path: string; size: number}>,
) {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes(`/api/models/${repoId}/tree/main`)) {
      return new Response(
        JSON.stringify(
          files.map((f) => ({
            type: 'file',
            path: f.path,
            size: f.size,
            ...(/\.(safetensors|bin)$/i.test(f.path)
              ? {lfs: {oid: `sha256:${f.path}`, size: f.size}}
              : {}),
          })),
        ),
        {status: 200},
      );
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;
}

test('detectMissingExpectedFiles clears stale flags and flags nothing for a diffusers repo', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-miss-'));
  const repoId = 'stabilityai/sdxl-turbo';
  // The user has only the single-file checkpoint — a complete packaging.
  await writeSized(
    path.join(base, repoId, 'sd_xl_turbo_1.0_fp16.safetensors'),
    50,
  );
  // A prior whole-repo audit wrongly recorded the rest of the pipeline missing.
  const sidecar: TjModel = {
    modelUrl: `https://huggingface.co/${repoId}`,
    repoId,
    files: [
      {
        path: 'sd_xl_turbo_1.0_fp16.safetensors',
        originUrl: `https://huggingface.co/${repoId}/blob/main/sd_xl_turbo_1.0_fp16.safetensors`,
        sourceSize: 50,
        computedSize: 50,
        sourceSha256: '',
        computedSha256: '',
      },
      {
        path: 'unet/diffusion_pytorch_model.safetensors',
        originUrl: `https://huggingface.co/${repoId}/blob/main/unet/diffusion_pytorch_model.safetensors`,
        sourceSize: 100,
        computedSize: 0,
        sourceSha256: 'x',
        computedSha256: '',
        missing: true,
      },
    ],
  };
  await fsp.writeFile(
    path.join(base, repoId, MODEL_SIDECAR_NAME),
    JSON.stringify(sidecar),
  );
  mockTreeLfs(repoId, [
    {path: 'sd_xl_turbo_1.0_fp16.safetensors', size: 50},
    {path: 'unet/diffusion_pytorch_model.safetensors', size: 100},
    {path: 'vae/diffusion_pytorch_model.safetensors', size: 20},
    {path: 'model_index.json', size: 6},
  ]);

  const out = await detectMissingExpectedFiles([repoId], base, 'main');
  // Nothing flagged — its other packagings/components aren't "missing".
  expect(out).toEqual([]);
  // The stale flag was cleared from the sidecar.
  const after = JSON.parse(
    await fsp.readFile(path.join(base, repoId, MODEL_SIDECAR_NAME), 'utf8'),
  ) as TjModel;
  expect(after.files.filter((f) => f.missing)).toEqual([]);
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
