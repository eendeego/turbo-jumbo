import {test, expect} from 'bun:test';
import {withPeerPaths} from '@/lib/peer-paths';
import type {Model} from '@/lib/models';
import type {
  ModelRow,
  QuantInfo,
} from '@/components/models/models-table-client';

function quant(label: string, paths: string[]): QuantInfo {
  return {
    label,
    filename: paths[0]?.split('/').pop() ?? null,
    displayName: paths[0]?.split('/').pop() ?? '',
    isSingleFile: paths.length === 1,
    inColdStorage: false,
    coldComplete: false,
    coldSize: null,
    size: 100,
    paths,
    coldPaths: [],
    shards: [],
    totalShards: 0,
    presentShards: 0,
    missingIndices: [],
  };
}

function row(name: string, quants: QuantInfo[]): ModelRow {
  return {
    name,
    quantizations: quants.map((q) => q.label).join(', '),
    quants,
    minSize: 100,
    maxSize: 100,
    allInColdStorage: false,
    noneInColdStorage: true,
  };
}

test('replaces local paths with the peer paths for matching quants', () => {
  const models = [
    row('LFM2-1.2B', [quant('Q6_K', ['org/LFM2-GGUF/LFM2-1.2B-Q6_K.gguf'])]),
  ];
  const peer: Model[] = [
    {
      name: 'LFM2-1.2B',
      files: [
        {
          isSplit: false,
          filename: 'LFM2-1.2B-Q6_K.gguf',
          path: 'LFM2-1.2B-Q6_K.gguf',
          quant: 'Q6_K',
          size: 100,
          missing: false,
        },
      ],
    },
  ];

  const out = withPeerPaths(models, peer);
  expect(out[0].quants[0].paths).toEqual(['LFM2-1.2B-Q6_K.gguf']);
});

test('keeps local paths for quants the peer does not have', () => {
  const models = [
    row('LFM2-1.2B', [quant('Q8_0', ['org/LFM2-GGUF/LFM2-1.2B-Q8_0.gguf'])]),
  ];
  const peer: Model[] = [
    {
      name: 'LFM2-1.2B',
      files: [
        {
          isSplit: false,
          filename: 'LFM2-1.2B-Q6_K.gguf',
          path: 'LFM2-1.2B-Q6_K.gguf',
          quant: 'Q6_K',
          size: 100,
          missing: false,
        },
      ],
    },
  ];

  const out = withPeerPaths(models, peer);
  expect(out[0].quants[0].paths).toEqual(['org/LFM2-GGUF/LFM2-1.2B-Q8_0.gguf']);
});

test('collects all shard paths for split quants', () => {
  const models = [
    row('Big-Model', [
      quant('Q4_K', [
        'org/Big-GGUF/Big-Q4_K-00001-of-00002.gguf',
        'org/Big-GGUF/Big-Q4_K-00002-of-00002.gguf',
      ]),
    ]),
  ];
  const peer: Model[] = [
    {
      name: 'Big-Model',
      files: [
        {
          isSplit: true,
          representativeFilename: 'Big-Q4_K-00001-of-00002.gguf',
          quant: 'Q4_K',
          totalShards: 2,
          presentShards: 2,
          missingIndices: [],
          totalSize: 100,
          files: [
            {path: 'Big-Q4_K-00001-of-00002.gguf', size: 50},
            {path: 'Big-Q4_K-00002-of-00002.gguf', size: 50},
          ],
        },
      ],
    },
  ];

  const out = withPeerPaths(models, peer);
  expect(out[0].quants[0].paths).toEqual([
    'Big-Q4_K-00001-of-00002.gguf',
    'Big-Q4_K-00002-of-00002.gguf',
  ]);
});

test('merges paths when the peer has duplicate copies of a quant', () => {
  const models = [row('LFM2-1.2B', [quant('Q6_K', ['LFM2-1.2B-Q6_K.gguf'])])];
  const peer: Model[] = [
    {
      name: 'LFM2-1.2B',
      files: [
        {
          isSplit: false,
          filename: 'LFM2-1.2B-Q6_K.gguf',
          path: 'LFM2-1.2B-Q6_K.gguf',
          quant: 'Q6_K',
          size: 100,
          missing: false,
        },
        {
          isSplit: false,
          filename: 'LFM2-1.2B-Q6_K.gguf',
          path: 'old/LFM2-1.2B-Q6_K.gguf',
          quant: 'Q6_K',
          size: 100,
          missing: false,
        },
      ],
    },
  ];

  const out = withPeerPaths(models, peer);
  expect(out[0].quants[0].paths).toEqual([
    'LFM2-1.2B-Q6_K.gguf',
    'old/LFM2-1.2B-Q6_K.gguf',
  ]);
});
