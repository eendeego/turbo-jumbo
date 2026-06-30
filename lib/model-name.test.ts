import {test, expect} from 'bun:test';
import {modelDisplayName, repoIdFromModelUrl} from '@/lib/model-name';

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
