import {test, expect} from 'bun:test';
import {extractModelName, extractQuant} from '@/lib/models';

test('detects a trailing quant token (dot- and dash-delimited)', () => {
  expect(extractQuant('My-Model.Q4_K_M.gguf')).toBe('Q4_K_M');
  expect(extractModelName('My-Model.Q4_K_M.gguf')).toBe('My-Model');
  expect(extractQuant('Llama-3-8B-Instruct-Q8_0.gguf')).toBe('Q8_0');
  expect(extractModelName('Llama-3-8B-Instruct-Q8_0.gguf')).toBe(
    'Llama-3-8B-Instruct',
  );
});

test('detects MXFP4 even when a descriptor suffix follows it', () => {
  const f = 'GPT-OSS-20B-Uncensored-HauhauCS-MXFP4-Aggressive.gguf';
  expect(extractQuant(f)).toBe('MXFP4');
  // The quant is removed from the middle, leaving the descriptor — which
  // matches the HuggingFace repo name for this model.
  expect(extractModelName(f)).toBe(
    'GPT-OSS-20B-Uncensored-HauhauCS-Aggressive',
  );
});

test('MXFP4 is recognized as a trailing token too', () => {
  expect(extractQuant('Some-Model-MXFP4.gguf')).toBe('MXFP4');
  expect(extractModelName('Some-Model-MXFP4.gguf')).toBe('Some-Model');
});

test('falls back to "unknown" when no quant token is present', () => {
  expect(extractQuant('Meta-Llama-3-8B-Instruct.gguf')).toBe('unknown');
  expect(extractModelName('Meta-Llama-3-8B-Instruct.gguf')).toBe(
    'Meta-Llama-3-8B-Instruct',
  );
});

test('prefers the last quant token when several appear', () => {
  expect(extractQuant('weird-F16-base-Q4_K_M.gguf')).toBe('Q4_K_M');
});
