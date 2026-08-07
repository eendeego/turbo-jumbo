import {describe, expect, test} from 'bun:test';
import {groupCopyFiles} from '@/lib/models/copy-file-groups';

describe('groupCopyFiles', () => {
  test('keeps single-file quants as one row each', () => {
    expect(
      groupCopyFiles([
        {model: 'org/repo-GGUF', quant: 'Q4_K_M', filename: 'a-Q4_K_M.gguf'},
        {model: 'org/repo-GGUF', quant: 'Q8_0', filename: 'a-Q8_0.gguf'},
      ]),
    ).toEqual([
      {label: 'a-Q4_K_M.gguf', description: 'repo-GGUF / Q4_K_M'},
      {label: 'a-Q8_0.gguf', description: 'repo-GGUF / Q8_0'},
    ]);
  });

  test('collapses a multi-file quant into a count and total size', () => {
    expect(
      groupCopyFiles([
        {
          model: 'deepseek-ai/DeepSeek-V4',
          quant: 'BF16',
          filename: 'model-00001-of-00003.safetensors',
          size: 3 * 1024 ** 3,
        },
        {
          model: 'deepseek-ai/DeepSeek-V4',
          quant: 'BF16',
          filename: 'model-00002-of-00003.safetensors',
          size: 3 * 1024 ** 3,
        },
        {
          model: 'deepseek-ai/DeepSeek-V4',
          quant: 'BF16',
          filename: 'model-00003-of-00003.safetensors',
          size: 2 * 1024 ** 3,
        },
      ]),
    ).toEqual([
      {label: 'DeepSeek-V4 / BF16', description: '3 files · 8.0 GiB'},
    ]);
  });

  test('omits the size when any shard size is unknown', () => {
    expect(
      groupCopyFiles([
        {model: 'm', quant: 'BF16', filename: 'a.safetensors', size: 1024},
        {model: 'm', quant: 'BF16', filename: 'b.safetensors'},
      ]),
    ).toEqual([{label: 'm / BF16', description: '2 files'}]);
  });

  test('interleaved quants group independently and keep first-seen order', () => {
    expect(
      groupCopyFiles([
        {model: 'm', quant: 'A', filename: 'a-1.safetensors', size: 1},
        {model: 'other', quant: 'Q8_0', filename: 'o.gguf'},
        {model: 'm', quant: 'A', filename: 'a-2.safetensors', size: 1},
      ]).map((e) => e.label),
    ).toEqual(['m / A', 'o.gguf']);
  });
});
