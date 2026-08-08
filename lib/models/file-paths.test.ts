import {test, expect} from 'bun:test';
import {filePaths, type ModelFile} from '@/lib/models/model-types';

const single = (over: Partial<ModelFile> = {}): ModelFile =>
  ({
    isSplit: false,
    filename: 'model.gguf',
    path: 'org/repo/model.gguf',
    quant: 'Q4_K_M',
    size: 10,
    ...over,
  }) as ModelFile;

const split = (paths: string[]): ModelFile =>
  ({
    isSplit: true,
    representativeFilename: 'model-00001-of-00003.gguf',
    files: paths.map((p) => ({path: p, size: 1})),
    quant: 'Q4_K_M',
    totalShards: 3,
    presentShards: paths.length,
    missingIndices: [],
    totalSize: paths.length,
  }) as ModelFile;

test('a single file is its own path', () => {
  expect(filePaths(single())).toEqual(['org/repo/model.gguf']);
});

test('a single file without a path falls back to its filename', () => {
  expect(filePaths(single({path: undefined}))).toEqual(['model.gguf']);
});

test('a split yields one path per present shard', () => {
  expect(filePaths(split(['org/repo/a.gguf', 'org/repo/b.gguf']))).toEqual([
    'org/repo/a.gguf',
    'org/repo/b.gguf',
  ]);
});

test('a split whose shards carry no paths falls back to its representative', () => {
  expect(filePaths(split([]))).toEqual(['model-00001-of-00003.gguf']);
});
