import {test, expect} from 'bun:test';
import {parseHubCachePath} from '@/lib/hf-cache';

test('decodes a snapshot file into repo, rev and in-repo path', () => {
  expect(
    parseHubCachePath(
      'models--unsloth--Qwen3-0.6B-GGUF/snapshots/abc123/Qwen3-0.6B-Q4_0.gguf',
    ),
  ).toEqual({
    repoId: 'unsloth/Qwen3-0.6B-GGUF',
    rev: 'abc123',
    repoPath: 'Qwen3-0.6B-Q4_0.gguf',
  });
});

test('keeps a nested in-repo path intact', () => {
  expect(
    parseHubCachePath(
      'models--ggml-org--gemma-3-4b-it-GGUF/snapshots/deadbeef/sub/dir/model.safetensors',
    ),
  ).toEqual({
    repoId: 'ggml-org/gemma-3-4b-it-GGUF',
    rev: 'deadbeef',
    repoPath: 'sub/dir/model.safetensors',
  });
});

test('returns null for non-cache and malformed paths', () => {
  // Flat layout — not a cache path.
  expect(parseHubCachePath('unsloth/Qwen3-0.6B-GGUF/file.gguf')).toBeNull();
  // Cache dir but no snapshot file (refs/blobs entries, or bare dir).
  expect(parseHubCachePath('models--unsloth--repo/refs/main')).toBeNull();
  expect(parseHubCachePath('models--unsloth--repo/blobs/abc')).toBeNull();
  expect(parseHubCachePath('models--unsloth--repo/snapshots/abc')).toBeNull();
  // models-- not at the storage root (configured a parent dir).
  expect(
    parseHubCachePath('hub/models--unsloth--repo/snapshots/abc/f.gguf'),
  ).toBeNull();
  // Decodes to something that isn't org/repo (one slash).
  expect(parseHubCachePath('models--justorg/snapshots/abc/f.gguf')).toBeNull();
});
