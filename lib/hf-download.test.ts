import {test, expect} from 'bun:test';
import {repoDownloadFiles, defaultDownloadSelection} from '@/lib/hf-download';

const safetensorsRepo = [
  'model-00001-of-00002.safetensors',
  'model-00002-of-00002.safetensors',
  'model.safetensors.index.json',
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'tokenizer.model',
  'special_tokens_map.json',
  'merges.txt',
  'chat_template.jinja',
  '.gitattributes',
  'README.md',
  'LICENSE',
  'model.onnx',
  'model.Q4_K_M.gguf',
  'preview.png',
];

test('repoDownloadFiles lists weights + companions for a safetensors repo', () => {
  const kept = repoDownloadFiles(safetensorsRepo);
  // Weights and every config/tokenizer/index companion are kept.
  expect(kept).toContain('model-00001-of-00002.safetensors');
  expect(kept).toContain('model.safetensors.index.json');
  expect(kept).toContain('config.json');
  expect(kept).toContain('tokenizer.model');
  expect(kept).toContain('merges.txt');
  expect(kept).toContain('chat_template.jinja');
  // Clutter is dropped: alternate-format weights, docs, images, git/license.
  expect(kept).not.toContain('.gitattributes');
  expect(kept).not.toContain('README.md');
  expect(kept).not.toContain('LICENSE');
  expect(kept).not.toContain('model.onnx');
  expect(kept).not.toContain('model.Q4_K_M.gguf');
  expect(kept).not.toContain('preview.png');
});

test('repoDownloadFiles lists only weights for a GGUF repo', () => {
  const kept = repoDownloadFiles([
    'model-Q4_K_M.gguf',
    'model-Q8_0.gguf',
    'config.json',
    'README.md',
    '.gitattributes',
  ]);
  expect(kept.sort()).toEqual(['model-Q4_K_M.gguf', 'model-Q8_0.gguf']);
});

test('repoDownloadFiles takes an ONNX model repo whole (Kokoro)', () => {
  // No GGUF and no safetensors: not a pick-a-quant repo, and isWeightFile can't
  // see the .onnx — so the whole repo is taken, matching Lemonade. Regression
  // for Kokoro, which previously yielded only voices-v1.0.bin.
  const kokoro = [
    '.gitattributes',
    'README.md',
    'index.json',
    'kokoro-v1.0.onnx',
    'voices-v1.0.bin',
  ];
  expect(repoDownloadFiles(kokoro)).toEqual(kokoro);
});

test('repoDownloadFiles takes a non-gguf/non-safetensors bin repo whole', () => {
  // A legacy pytorch .bin model needs its config to run, so it's taken whole
  // rather than weight-only.
  const kept = repoDownloadFiles([
    'pytorch_model.bin',
    'config.json',
    'README.md',
  ]);
  expect(kept).toEqual(['pytorch_model.bin', 'config.json', 'README.md']);
});

test('repoDownloadFiles picks weights individually for a ggml .bin repo (whisper.cpp)', () => {
  // Many standalone ggml-*.bin models, no onnx/safetensors/gguf, no config:
  // pick-one like GGUF — list the weights, not the whole repo (which would
  // wrongly expect every variant, unlike Lemonade's one-file-per-model pull).
  const whisper = [
    '.gitattributes',
    'README.md',
    'ggml-tiny.bin',
    'ggml-base.bin',
    'ggml-large-v3-turbo.bin',
    'ggml-base-encoder.mlmodelc.zip',
  ];
  expect(repoDownloadFiles(whisper)).toEqual([
    'ggml-tiny.bin',
    'ggml-base.bin',
    'ggml-large-v3-turbo.bin',
  ]);
});

const asFiles = (paths: string[]) => paths.map((path) => ({path}));

test('defaultDownloadSelection takes the whole safetensors model', () => {
  const files = asFiles(repoDownloadFiles(safetensorsRepo));
  // A bare repo URL (no specific file) still selects every listed file.
  const sel = defaultDownloadSelection(files, null);
  expect(sel.size).toBe(files.length);
  expect(sel.has('config.json')).toBe(true);
  expect(sel.has('model-00001-of-00002.safetensors')).toBe(true);
});

test('defaultDownloadSelection selects nothing for a bare GGUF repo URL', () => {
  const files = asFiles(['a-Q4_K_M.gguf', 'a-Q8_0.gguf']);
  expect(defaultDownloadSelection(files, null).size).toBe(0);
});

test('defaultDownloadSelection picks a GGUF shard set from one shard name', () => {
  const files = asFiles([
    'big-Q4_K_M-00001-of-00002.gguf',
    'big-Q4_K_M-00002-of-00002.gguf',
    'big-Q8_0.gguf',
  ]);
  const sel = defaultDownloadSelection(files, 'big-Q4_K_M-00001-of-00002.gguf');
  expect([...sel].sort()).toEqual([
    'big-Q4_K_M-00001-of-00002.gguf',
    'big-Q4_K_M-00002-of-00002.gguf',
  ]);
});

test('defaultDownloadSelection picks a single named GGUF file', () => {
  const files = asFiles(['a-Q4_K_M.gguf', 'a-Q8_0.gguf']);
  expect([...defaultDownloadSelection(files, 'a-Q8_0.gguf')]).toEqual([
    'a-Q8_0.gguf',
  ]);
});
