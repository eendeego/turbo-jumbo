import {test, expect} from 'bun:test';
import {parseHfUrl} from '@/lib/hf/hf-url';

test('parses a bare org/repo', () => {
  expect(parseHfUrl('unsloth/GLM-4.7-GGUF')).toEqual({
    repoId: 'unsloth/GLM-4.7-GGUF',
    branch: 'main',
    folder: null,
    filename: null,
  });
});

test('parses a blob file URL with a folder', () => {
  expect(
    parseHfUrl('https://huggingface.co/org/repo/blob/main/sub/file.gguf'),
  ).toEqual({
    repoId: 'org/repo',
    branch: 'main',
    folder: 'sub',
    filename: 'file.gguf',
  });
});

test('parses a tree/branch URL', () => {
  expect(parseHfUrl('https://huggingface.co/org/repo/tree/main')).toEqual({
    repoId: 'org/repo',
    branch: 'main',
    folder: null,
    filename: null,
  });
});

test('returns null for a non-HF string', () => {
  expect(parseHfUrl('not a url')).toBeNull();
});
