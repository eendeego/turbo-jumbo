import {test, expect} from 'bun:test';
import {
  selectedFileInfo,
  anyMissingFromColdStorage,
} from '@/components/models/delete-modal';
import type {Model} from '@/lib/models/model-types';

const SHARDS = [
  {path: 'org/repo/model-00001-of-00003.safetensors', size: 10},
  {path: 'org/repo/model-00002-of-00003.safetensors', size: 20},
  {path: 'org/repo/model-00003-of-00003.safetensors', size: 30},
];

// `representative` differs per host: it comes from directory order, so the same
// split is represented by a different shard on each machine.
function splitModel(representative: string, shards = SHARDS): Model {
  return {
    name: 'org/repo',
    files: [
      {
        isSplit: true,
        representativeFilename: representative,
        files: shards,
        quant: 'BF16',
        totalShards: 3,
        presentShards: shards.length,
        missingIndices: [],
        totalSize: shards.reduce((n, s) => n + s.size, 0),
      },
    ],
  };
}

test('selectedFileInfo lists every selected shard, with its size', () => {
  const info = selectedFileInfo(
    [splitModel('model-00001-of-00003.safetensors')],
    new Set(SHARDS.map((s) => s.path)),
  );
  expect(info.map((f) => f.filename)).toEqual([
    'model-00001-of-00003.safetensors',
    'model-00002-of-00003.safetensors',
    'model-00003-of-00003.safetensors',
  ]);
  expect(info.map((f) => f.size)).toEqual([10, 20, 30]);
});

test('selectedFileInfo keeps a single-file quant as one entry', () => {
  const model: Model = {
    name: 'org/repo-GGUF',
    files: [
      {
        isSplit: false,
        filename: 'a-Q4_K_M.gguf',
        path: 'org/repo-GGUF/a-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        size: 99,
        missing: false,
      },
    ],
  };
  expect(
    selectedFileInfo([model], new Set(['org/repo-GGUF/a-Q4_K_M.gguf'])),
  ).toEqual([
    {
      model: 'org/repo-GGUF',
      quant: 'Q4_K_M',
      filename: 'a-Q4_K_M.gguf',
      size: 99,
    },
  ]);
});

// The two sides pick different representative shards, so comparing those names
// to each other reported a fully-backed split as missing from cold storage.
test('a split fully present in cold storage is not reported missing', () => {
  const files = selectedFileInfo(
    [splitModel('model-00001-of-00003.safetensors')],
    new Set(SHARDS.map((s) => s.path)),
  );
  const cold = [splitModel('model-00003-of-00003.safetensors')];
  expect(anyMissingFromColdStorage(files, cold)).toBe(false);
});

test('a split missing a shard in cold storage is reported missing', () => {
  const files = selectedFileInfo(
    [splitModel('model-00001-of-00003.safetensors')],
    new Set(SHARDS.map((s) => s.path)),
  );
  const cold = [
    splitModel('model-00002-of-00003.safetensors', SHARDS.slice(0, 2)),
  ];
  expect(anyMissingFromColdStorage(files, cold)).toBe(true);
});

test('a different model holding the same generic shard name does not count', () => {
  const files = selectedFileInfo(
    [splitModel('model-00001-of-00003.safetensors')],
    new Set(SHARDS.map((s) => s.path)),
  );
  const other = splitModel('model-00001-of-00003.safetensors');
  expect(
    anyMissingFromColdStorage(files, [{...other, name: 'org/other'}]),
  ).toBe(true);
});
