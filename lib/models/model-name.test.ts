import {test, expect} from 'bun:test';
import {
  modelDisplayName,
  repoIdFromModelUrl,
  isMmprojFilename,
} from '@/lib/models/model-name';

test('repoIdFromModelUrl extracts org/repo from a model URL', () => {
  expect(
    repoIdFromModelUrl(
      'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    ),
  ).toBe('unsloth/Qwen3.6-35B-A3B-MTP-GGUF');
  // Trailing slash and whitespace are tolerated.
  expect(repoIdFromModelUrl('  https://huggingface.co/o/r/  ')).toBe('o/r');
});

test('repoIdFromModelUrl rejects non-model / non-HF URLs', () => {
  expect(repoIdFromModelUrl('https://huggingface.co/just-org')).toBeNull();
  expect(repoIdFromModelUrl('https://example.com/o/r')).toBeNull();
  expect(repoIdFromModelUrl('not a url')).toBeNull();
});

test('modelDisplayName shows the repo segment of an org/repo', () => {
  expect(modelDisplayName('unsloth/Qwen3.6-35B-A3B-MTP-GGUF')).toBe(
    'Qwen3.6-35B-A3B-MTP-GGUF',
  );
});

test('modelDisplayName leaves a filename-derived name unchanged', () => {
  expect(modelDisplayName('Qwen3.6-35B-A3B')).toBe('Qwen3.6-35B-A3B');
});

test('isMmprojFilename matches GGUF projector files', () => {
  expect(isMmprojFilename('mmproj-F16.gguf')).toBe(true);
  expect(isMmprojFilename('MMPROJ-BF16.GGUF')).toBe(true);
});

test('isMmprojFilename rejects non-projectors and non-gguf', () => {
  expect(isMmprojFilename('mmproj')).toBe(false);
  expect(isMmprojFilename('mmproj-readme.txt')).toBe(false);
  expect(isMmprojFilename('Qwen3-Q4_0.gguf')).toBe(false);
});
