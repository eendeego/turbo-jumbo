import {test, expect} from 'bun:test';
import {buildDisplayRows, type ModelRow, type QuantInfo} from '@/lib/model-row';

function quant(p: Partial<QuantInfo> & {label: string}): QuantInfo {
  return {
    filename: `${p.label}.gguf`,
    displayName: `${p.label}.gguf`,
    isSingleFile: true,
    inColdStorage: false,
    coldComplete: false,
    coldSize: null,
    coldTotalSize: 0,
    size: 100,
    paths: [`m/${p.label}.gguf`],
    coldPaths: [],
    shards: [],
    totalShards: 0,
    presentShards: 0,
    missingIndices: [],
    ...p,
  };
}

function model(
  p: Partial<ModelRow> & {name: string; quants: QuantInfo[]},
): ModelRow {
  return {
    quantizations: '',
    minSize: 0,
    maxSize: 0,
    allInColdStorage: false,
    noneInColdStorage: true,
    ...p,
  };
}

const noPeers = {
  expanded: new Set<string>(),
  repoFiles: new Map(),
  activeLocation: 'all',
  peerQuantSizes: new Map<string, Array<{address: string; size: number}>>(),
  peerNameByAddr: new Map<string, string>(),
};

test('a collapsed model yields a single depth-0 row', () => {
  const rows = buildDisplayRows({
    ...noPeers,
    models: [
      model({name: 'org/repo', quants: [quant({label: 'Q4', size: 100})]}),
    ],
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({key: 'org/repo', depth: 0, label: 'org/repo'});
});

test('an expanded model adds its quant rows, and an expanded split quant its shards', () => {
  const split = quant({
    label: 'Q8',
    isSingleFile: false,
    filename: null,
    displayName: 'model-00001-of-00002.gguf',
    paths: ['m/a', 'm/b'],
    shards: [
      {filename: 'model-00001-of-00002.gguf', size: 50},
      {filename: 'model-00002-of-00002.gguf', size: 50},
    ],
    totalShards: 2,
    presentShards: 2,
  });
  const rows = buildDisplayRows({
    ...noPeers,
    expanded: new Set(['org/repo', 'org/repo::Q8']),
    models: [model({name: 'org/repo', quants: [split]})],
  });
  // model row + quant row + 2 shard rows
  expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2]);
  expect(rows[2].label).toBe('model-00001-of-00002.gguf');
});

test('a quant whose cold and peer copies disagree is flagged as a size mismatch', () => {
  const q = quant({label: 'Q4', size: 100, coldTotalSize: 100});
  const rows = buildDisplayRows({
    ...noPeers,
    expanded: new Set(['org/repo']),
    // Peer holds a smaller (undersized) copy of the same file.
    peerQuantSizes: new Map([
      ['org/repo::Q4.gguf', [{address: '192.0.2.2:3000', size: 90}]],
    ]),
    peerNameByAddr: new Map([['192.0.2.2:3000', 'my-server']]),
    models: [model({name: 'org/repo', quants: [q]})],
  });
  const modelRow = rows.find((r) => r.depth === 0)!;
  const quantRow = rows.find((r) => r.depth === 1)!;
  expect(modelRow.sizeMismatch).toBe(true);
  expect(quantRow.sizeMismatch).toBe(true);
  // The effective size is the largest copy (cold's 100); the peer's 90 is undersized.
  expect(quantRow.size).toBe(100);
  expect(quantRow.undersizedLocations.has('192.0.2.2:3000')).toBe(true);
});
