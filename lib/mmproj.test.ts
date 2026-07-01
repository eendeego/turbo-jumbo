import {test, expect} from 'bun:test';
import {pickMmproj, hasLocalMmproj} from '@/lib/mmproj';

test('pickMmproj prefers F16 over BF16 and F32', () => {
  expect(
    pickMmproj(['mmproj-BF16.gguf', 'mmproj-F16.gguf', 'mmproj-F32.gguf']),
  ).toBe('mmproj-F16.gguf');
});

test('pickMmproj falls back to BF16 when no F16', () => {
  expect(pickMmproj(['mmproj-F32.gguf', 'mmproj-BF16.gguf'])).toBe(
    'mmproj-BF16.gguf',
  );
});

test('pickMmproj uses F32 when it is the only preferred match', () => {
  expect(pickMmproj(['mmproj-F32.gguf'])).toBe('mmproj-F32.gguf');
});

test('pickMmproj returns the first mmproj when none match the preference list', () => {
  expect(pickMmproj(['Qwen3-Q4_0.gguf', 'mmproj-Q8_0.gguf'])).toBe(
    'mmproj-Q8_0.gguf',
  );
});

test('pickMmproj returns null when there is no mmproj', () => {
  expect(pickMmproj(['Qwen3-Q4_0.gguf', 'config.json'])).toBeNull();
});

test('hasLocalMmproj matches a flat-mirror path under the repo', () => {
  const paths = [
    'unsloth/Qwen3.6-35B-A3B-MTP-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
    'unsloth/Qwen3.6-35B-A3B-MTP-GGUF/mmproj-F16.gguf',
  ];
  expect(hasLocalMmproj(paths, 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF')).toBe(true);
});

test('hasLocalMmproj matches a hub-cache path decoding to the repo', () => {
  const paths = [
    'models--unsloth--Qwen3.6-35B-A3B-MTP-GGUF/snapshots/abc123/mmproj-F16.gguf',
  ];
  expect(hasLocalMmproj(paths, 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF')).toBe(true);
});

test('hasLocalMmproj ignores an mmproj that belongs to a different repo', () => {
  const paths = ['someone/Other-GGUF/mmproj-F16.gguf'];
  expect(hasLocalMmproj(paths, 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF')).toBe(false);
});

test('hasLocalMmproj is false when no mmproj is present', () => {
  const paths = [
    'unsloth/Qwen3.6-35B-A3B-MTP-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
  ];
  expect(hasLocalMmproj(paths, 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF')).toBe(false);
});
