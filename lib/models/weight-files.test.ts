import {test, expect} from 'bun:test';
import {isWeightFile, ggmlModelVariant} from '@/lib/models/weight-files';

test('isWeightFile recognizes weight extensions, ignoring directory prefix', () => {
  expect(isWeightFile('model.gguf')).toBe(true);
  expect(isWeightFile('sub/dir/ggml-tiny.bin')).toBe(true);
  expect(isWeightFile('config.json')).toBe(false);
});

test('ggmlModelVariant extracts the variant from a whisper ggml .bin name', () => {
  expect(ggmlModelVariant('ggml-tiny.bin')).toBe('tiny');
  expect(ggmlModelVariant('ggml-large-v3-turbo.bin')).toBe('large-v3-turbo');
  expect(ggmlModelVariant('ggml-large-v3-turbo-q5_0.bin')).toBe(
    'large-v3-turbo-q5_0',
  );
});

test('ggmlModelVariant ignores any directory prefix and is case-insensitive', () => {
  expect(ggmlModelVariant('sub/dir/ggml-base.bin')).toBe('base');
  expect(ggmlModelVariant('GGML-Tiny.BIN')).toBe('Tiny');
});

test('ggmlModelVariant returns null for non-ggml weight files', () => {
  expect(ggmlModelVariant('pytorch_model.bin')).toBeNull();
  expect(ggmlModelVariant('model.safetensors')).toBeNull();
  expect(ggmlModelVariant('model.Q4_K_M.gguf')).toBeNull();
  expect(ggmlModelVariant('ggml-tiny.gguf')).toBeNull();
  expect(ggmlModelVariant('ggml.bin')).toBeNull();
});
