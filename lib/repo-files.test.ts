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

test('clutter like .gitattributes is never reported as a required file', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-rf-'));
  const repoId = 'rf/with-clutter';
  mockTree(repoId, [
    {path: 'model.onnx', size: 100},
    {path: '.gitattributes', size: 5},
    {path: 'README.md', size: 10},
  ]);
  await writeFileOfSize(path.join(base, repoId, 'model.onnx'), 100);
  // .gitattributes and README.md are absent locally but must not be flagged.
  const out = await repoFileStatuses(base, repoId);
  expect(out.map((f) => f.path)).toEqual(['model.onnx']);
  await fsp.rm(base, {recursive: true, force: true});
});

test('a split_files bundle reports only present files, not un-downloaded variants', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-rf-'));
  const repoId = 'Comfy-Org/vae-text-encorder-for-flux-klein-9b';
  mockTree(repoId, [
    {path: '.gitattributes', size: 5},
    {path: 'split_files/vae/flux2-vae.safetensors', size: 200},
    {path: 'split_files/text_encoders/qwen_3_8b.safetensors', size: 800},
    {
      path: 'split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors',
      size: 400,
    },
  ]);
  // Only the VAE is downloaded; the text-encoder quants aren't "missing".
  await writeFileOfSize(
    path.join(base, repoId, 'split_files/vae/flux2-vae.safetensors'),
    200,
  );
  const out = await repoFileStatuses(base, repoId);
  expect(out.map((f) => f.path)).toEqual([
    'split_files/vae/flux2-vae.safetensors',
  ]);
  expect(out[0].state).toBe('present');
  await fsp.rm(base, {recursive: true, force: true});
});

test('a diffusers pipeline reports only present component files', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-rf-'));
  const repoId = 'stabilityai/sdxl-turbo';
  mockTree(repoId, [
    {path: 'model_index.json', size: 600},
    {path: 'unet/diffusion_pytorch_model.fp16.safetensors', size: 5000},
    {path: 'unet/diffusion_pytorch_model.safetensors', size: 10000},
    {path: 'vae/diffusion_pytorch_model.fp16.safetensors', size: 160},
    {path: 'text_encoder/model.fp16.safetensors', size: 246},
  ]);
  // Only the fp16 unet and vae are downloaded.
  await writeFileOfSize(
    path.join(base, repoId, 'unet/diffusion_pytorch_model.fp16.safetensors'),
    5000,
  );
  await writeFileOfSize(
    path.join(base, repoId, 'vae/diffusion_pytorch_model.fp16.safetensors'),
    160,
  );
  const out = await repoFileStatuses(base, repoId);
  expect(out.map((f) => f.path).sort()).toEqual([
    'unet/diffusion_pytorch_model.fp16.safetensors',
    'vae/diffusion_pytorch_model.fp16.safetensors',
  ]);
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
  mockTree(repoId, [{path: 'tokenizer.json', size: 10}]);
  await writeFileOfSize(path.join(base, repoId, 'tokenizer.json'), 10);
  // No tjmodel.json at all — the unknown-size rule is scoped to recorded
  // metadata, so an unrecorded file is judged on size alone.

  const out = await repoFileStatuses(base, repoId);
  expect(out.find((f) => f.path === 'tokenizer.json')?.state).toBe('present');
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

test('a pick-one ggml .bin repo reports only present files, never missing variants', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-rf-'));
  const repoId = 'rf/whisper.cpp';
  // The repo holds many ggml-*.bin models; only one is downloaded locally.
  mockTree(repoId, [
    {path: 'ggml-tiny.bin', size: 10},
    {path: 'ggml-base.bin', size: 20},
    {path: 'ggml-large-v3.bin', size: 30},
  ]);
  await writeFileOfSize(path.join(base, repoId, 'ggml-base.bin'), 20);

  const out = await repoFileStatuses(base, repoId);
  // Like GGUF: just the present variant, no "missing" rows for the others.
  expect(out).toEqual([
    {path: 'ggml-base.bin', state: 'present', size: 20, expectedSize: 20},
  ]);
  await fsp.rm(base, {recursive: true, force: true});
});
