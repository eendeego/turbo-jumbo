import {test, expect} from 'bun:test';
import {
  lemonadeDownloadStatus,
  lemonadeGgufModels,
  lemonadeStatusTooltip,
  matchVariantFiles,
  parseCheckpoint,
  type InventoryLocation,
  type LemonadeModel,
} from '@/lib/lemonade';
import type {Model} from '@/lib/model-types';

test('parseCheckpoint splits a repo from its variant', () => {
  expect(parseCheckpoint('unsloth/Qwen3-0.6B-GGUF:Q4_0')).toEqual({
    repoId: 'unsloth/Qwen3-0.6B-GGUF',
    variant: 'Q4_0',
  });
  expect(
    parseCheckpoint(
      'unsloth/gemma-3-270m-it-GGUF:gemma-3-270m-it-UD-IQ2_M.gguf',
    ),
  ).toEqual({
    repoId: 'unsloth/gemma-3-270m-it-GGUF',
    variant: 'gemma-3-270m-it-UD-IQ2_M.gguf',
  });
  expect(parseCheckpoint('pqnet/bge-reranker-v2-m3-Q8_0-GGUF')).toEqual({
    repoId: 'pqnet/bge-reranker-v2-m3-Q8_0-GGUF',
    variant: null,
  });
});

test('parseCheckpoint rejects malformed checkpoints', () => {
  expect(parseCheckpoint('not-a-repo')).toBeNull();
  expect(parseCheckpoint('a/b/c')).toBeNull();
  expect(parseCheckpoint('or g/repo')).toBeNull();
});

test('lemonadeGgufModels keeps llamacpp entries and maps their fields', () => {
  const models = lemonadeGgufModels({
    'Qwen3-0.6B-GGUF': {
      checkpoint: 'unsloth/Qwen3-0.6B-GGUF:Q4_0',
      recipe: 'llamacpp',
      suggested: true,
      labels: ['reasoning'],
      size: 0.38,
    },
    'Gemma-3-4b-it-GGUF': {
      checkpoint: 'ggml-org/gemma-3-4b-it-GGUF:Q4_K_M',
      mmproj: 'mmproj-model-f16.gguf',
      recipe: 'llamacpp',
      suggested: false,
      labels: ['vision'],
      size: 3.34,
    },
    'Some-ONNX-Model': {
      checkpoint: 'amd/some-onnx-thing',
      recipe: 'ryzenai-llm',
      suggested: true,
      size: 9.09,
    },
  });
  expect(models).toEqual([
    {
      name: 'Qwen3-0.6B-GGUF',
      repoId: 'unsloth/Qwen3-0.6B-GGUF',
      variant: 'Q4_0',
      mmproj: null,
      suggested: true,
      labels: ['reasoning'],
      sizeGb: 0.38,
    },
    {
      name: 'Gemma-3-4b-it-GGUF',
      repoId: 'ggml-org/gemma-3-4b-it-GGUF',
      variant: 'Q4_K_M',
      mmproj: 'mmproj-model-f16.gguf',
      suggested: false,
      labels: ['vision'],
      sizeGb: 3.34,
    },
  ]);
});

test('lemonadeGgufModels skips malformed entries instead of failing', () => {
  expect(
    lemonadeGgufModels({
      ok: {checkpoint: 'o/r:Q4_0', recipe: 'llamacpp', size: 1},
      'bad-checkpoint': {checkpoint: 'nope', recipe: 'llamacpp', size: 1},
      'not-an-object': 42,
    }),
  ).toHaveLength(1);
  expect(lemonadeGgufModels(null)).toEqual([]);
  expect(lemonadeGgufModels([1, 2])).toEqual([]);
});

const files = [
  {path: 'Qwen3-0.6B-Q4_0.gguf', size: 100},
  {path: 'Qwen3-0.6B-Q8_0.gguf', size: 200},
  {path: 'mmproj-model-f16.gguf', size: 10},
  {path: 'README.md', size: 1},
];

test('matchVariantFiles picks files carrying the quant token', () => {
  expect(matchVariantFiles(files, 'Q4_0', null)).toEqual([
    'Qwen3-0.6B-Q4_0.gguf',
  ]);
  // The token matches case-insensitively.
  expect(matchVariantFiles(files, 'q4_0', null)).toEqual([
    'Qwen3-0.6B-Q4_0.gguf',
  ]);
});

test('matchVariantFiles resolves an exact-filename variant', () => {
  expect(matchVariantFiles(files, 'Qwen3-0.6B-Q8_0.gguf', null)).toEqual([
    'Qwen3-0.6B-Q8_0.gguf',
  ]);
});

test('matchVariantFiles takes every gguf when there is no variant', () => {
  // Single-quant repos (e.g. pqnet/bge-reranker-v2-m3-Q8_0-GGUF) list the
  // whole checkpoint without a variant; mmproj files don't belong unless
  // asked for.
  expect(matchVariantFiles(files, null, null)).toEqual([
    'Qwen3-0.6B-Q4_0.gguf',
    'Qwen3-0.6B-Q8_0.gguf',
  ]);
});

test('matchVariantFiles appends the mmproj file when the model needs one', () => {
  expect(matchVariantFiles(files, 'Q4_0', 'mmproj-model-f16.gguf')).toEqual([
    'Qwen3-0.6B-Q4_0.gguf',
    'mmproj-model-f16.gguf',
  ]);
});

test('matchVariantFiles excludes mmproj files from token matches', () => {
  // "f16"-style tokens must not accidentally pull companion mmproj files.
  const repo = [
    {path: 'model-F16.gguf', size: 100},
    {path: 'mmproj-model-f16.gguf', size: 10},
  ];
  expect(matchVariantFiles(repo, 'F16', null)).toEqual(['model-F16.gguf']);
});

test('matchVariantFiles matches split shards of the variant', () => {
  const sharded = [
    {path: 'big-Q4_K_M-00001-of-00002.gguf', size: 1},
    {path: 'big-Q4_K_M-00002-of-00002.gguf', size: 1},
    {path: 'big-Q8_0.gguf', size: 2},
  ];
  expect(matchVariantFiles(sharded, 'Q4_K_M', null)).toEqual([
    'big-Q4_K_M-00001-of-00002.gguf',
    'big-Q4_K_M-00002-of-00002.gguf',
  ]);
});

// --- lemonadeDownloadStatus ---------------------------------------------

function model(over: Partial<LemonadeModel> = {}): LemonadeModel {
  return {
    name: 'Qwen3-0.6B-GGUF',
    repoId: 'unsloth/Qwen3-0.6B-GGUF',
    variant: 'Q4_0',
    mmproj: null,
    suggested: false,
    labels: [],
    sizeGb: 0.4,
    ...over,
  };
}

// A single-file model named by its repo (as the hub-cache scan names it).
function repoModel(name: string, files: Model['files']): Model {
  return {name, files};
}

function single(
  filename: string,
  quant: string,
  missing = false,
): Model['files'][number] {
  return {isSplit: false, filename, path: filename, quant, size: 1, missing};
}

function loc(name: string, models: Model[]): InventoryLocation {
  return {name, models};
}

test('lemonadeDownloadStatus matches a quant-token variant case-insensitively', () => {
  const local = loc('local', [
    repoModel('unsloth/Qwen3-0.6B-GGUF', [
      single('Qwen3-0.6B-Q4_0.gguf', 'Q4_0'),
    ]),
  ]);
  const info = lemonadeDownloadStatus(model({variant: 'q4_0'}), [local]);
  expect(info.status).toBe('complete');
  expect(info.locations).toEqual([{name: 'local', status: 'complete'}]);
});

test('lemonadeDownloadStatus matches an exact-filename variant', () => {
  const local = loc('local', [
    repoModel('unsloth/gemma-3-270m-it-GGUF', [
      single('gemma-3-270m-it-UD-IQ2_M.gguf', 'IQ2_M'),
    ]),
  ]);
  const info = lemonadeDownloadStatus(
    model({
      repoId: 'unsloth/gemma-3-270m-it-GGUF',
      variant: 'gemma-3-270m-it-UD-IQ2_M.gguf',
    }),
    [local],
  );
  expect(info.status).toBe('complete');
});

test('lemonadeDownloadStatus matches a whole-repo (null) variant via any gguf', () => {
  const local = loc('local', [
    repoModel('pqnet/bge-reranker-v2-m3-Q8_0-GGUF', [
      single('bge-reranker-v2-m3-Q8_0.gguf', 'Q8_0'),
    ]),
  ]);
  const info = lemonadeDownloadStatus(
    model({repoId: 'pqnet/bge-reranker-v2-m3-Q8_0-GGUF', variant: null}),
    [local],
  );
  expect(info.status).toBe('complete');
});

test('lemonadeDownloadStatus reports partial when a shard is missing', () => {
  const split: Model['files'][number] = {
    isSplit: true,
    representativeFilename: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf',
    files: [{path: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf', size: 1}],
    quant: 'Q4_0',
    totalShards: 2,
    presentShards: 1,
    missingIndices: [2],
    totalSize: 1,
  };
  const local = loc('local', [repoModel('unsloth/Qwen3-0.6B-GGUF', [split])]);
  const info = lemonadeDownloadStatus(model(), [local]);
  expect(info.status).toBe('partial');
  expect(info.locations).toEqual([{name: 'local', status: 'partial'}]);
});

test('lemonadeDownloadStatus reports partial when the named mmproj is absent', () => {
  const local = loc('local', [
    repoModel('unsloth/Qwen3-VL-GGUF', [single('Qwen3-VL-Q4_0.gguf', 'Q4_0')]),
  ]);
  const info = lemonadeDownloadStatus(
    model({repoId: 'unsloth/Qwen3-VL-GGUF', mmproj: 'mmproj-F16.gguf'}),
    [local],
  );
  expect(info.status).toBe('partial');
});

test('lemonadeDownloadStatus is complete when the named mmproj is present', () => {
  const local = loc('local', [
    repoModel('unsloth/Qwen3-VL-GGUF', [
      single('Qwen3-VL-Q4_0.gguf', 'Q4_0'),
      single('mmproj-F16.gguf', 'F16'),
    ]),
  ]);
  const info = lemonadeDownloadStatus(
    model({repoId: 'unsloth/Qwen3-VL-GGUF', mmproj: 'mmproj-F16.gguf'}),
    [local],
  );
  expect(info.status).toBe('complete');
});

test('lemonadeDownloadStatus returns none when nothing matches', () => {
  const local = loc('local', [
    repoModel('someone/else-GGUF', [single('else-Q4_0.gguf', 'Q4_0')]),
  ]);
  const info = lemonadeDownloadStatus(model(), [local]);
  expect(info.status).toBe('none');
  expect(info.locations).toEqual([]);
});

test('lemonadeDownloadStatus takes the best status across locations, preserving order', () => {
  const partialSplit: Model['files'][number] = {
    isSplit: true,
    representativeFilename: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf',
    files: [{path: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf', size: 1}],
    quant: 'Q4_0',
    totalShards: 2,
    presentShards: 1,
    missingIndices: [2],
    totalSize: 1,
  };
  const myServer = loc('my-server', [
    repoModel('unsloth/Qwen3-0.6B-GGUF', [partialSplit]),
  ]);
  const cold = loc('cold storage', [
    repoModel('unsloth/Qwen3-0.6B-GGUF', [
      single('Qwen3-0.6B-Q4_0.gguf', 'Q4_0'),
    ]),
  ]);
  const info = lemonadeDownloadStatus(model(), [myServer, cold]);
  expect(info.status).toBe('complete');
  expect(info.locations).toEqual([
    {name: 'my-server', status: 'partial'},
    {name: 'cold storage', status: 'complete'},
  ]);
});

// --- lemonadeStatusTooltip ----------------------------------------------

test('lemonadeStatusTooltip groups locations by status', () => {
  expect(
    lemonadeStatusTooltip({
      status: 'complete',
      locations: [
        {name: 'my-server', status: 'partial'},
        {name: 'cold storage', status: 'complete'},
        {name: 'local', status: 'complete'},
      ],
    }),
  ).toBe('Complete: cold storage, local. Partial: my-server.');
});

test('lemonadeDownloadStatus reports partial when a single file is missing', () => {
  const local = loc('local', [
    repoModel('unsloth/Qwen3-0.6B-GGUF', [
      single('Qwen3-0.6B-Q4_0.gguf', 'Q4_0', true /* missing */),
    ]),
  ]);
  const info = lemonadeDownloadStatus(model(), [local]);
  expect(info.status).toBe('partial');
});

test('lemonadeDownloadStatus matches an exact-filename variant against a split group', () => {
  const split: Model['files'][number] = {
    isSplit: true,
    representativeFilename: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf',
    files: [
      {path: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf', size: 1},
      {path: 'Qwen3-0.6B-Q4_0-00002-of-00002.gguf', size: 1},
    ],
    quant: 'Q4_0',
    totalShards: 2,
    presentShards: 2,
    missingIndices: [],
    totalSize: 2,
  };
  const local = loc('local', [repoModel('unsloth/Qwen3-0.6B-GGUF', [split])]);
  const info = lemonadeDownloadStatus(
    model({variant: 'Qwen3-0.6B-Q4_0.gguf'}),
    [local],
  );
  expect(info.status).toBe('complete');
});
