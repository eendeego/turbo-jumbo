import {test, expect} from 'bun:test';
import {peerFileBasenames, withPeerPaths} from '@/lib/peer-paths';
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
    coldTotalSize: 0,
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

test('matches quants by filename when the hosts disagree on the model name', () => {
  // The same file is named after its sidecar repo on the peer (it was audited
  // and relocated there) but after its filename locally — the join must not
  // depend on the per-host model name.
  const models = [
    row('Jan-nano-128k', [
      quant('UD-Q6_K_XL', ['Jan-nano-128k-UD-Q6_K_XL.gguf']),
    ]),
  ];
  const peer: Model[] = [
    {
      name: 'unsloth/Jan-nano-128k-GGUF',
      files: [
        {
          isSplit: false,
          filename: 'Jan-nano-128k-UD-Q6_K_XL.gguf',
          path: 'unsloth/Jan-nano-128k-GGUF/Jan-nano-128k-UD-Q6_K_XL.gguf',
          quant: 'UD-Q6_K_XL',
          size: 100,
          missing: false,
        },
      ],
    },
  ];

  const out = withPeerPaths(models, peer);
  expect(out[0].quants[0].paths).toEqual([
    'unsloth/Jan-nano-128k-GGUF/Jan-nano-128k-UD-Q6_K_XL.gguf',
  ]);
});

test('peerFileBasenames lists every file basename on the peer', () => {
  const peer: Model[] = [
    {
      name: 'unsloth/LFM2-1.2B-GGUF',
      files: [
        {
          isSplit: false,
          filename: 'LFM2-1.2B-Q6_K.gguf',
          path: 'unsloth/LFM2-1.2B-GGUF/LFM2-1.2B-Q6_K.gguf',
          quant: 'Q6_K',
          size: 100,
          missing: false,
        },
      ],
    },
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
            {path: 'sub/Big-Q4_K-00001-of-00002.gguf', size: 50},
            {path: 'sub/Big-Q4_K-00002-of-00002.gguf', size: 50},
          ],
        },
      ],
    },
  ];

  expect(peerFileBasenames(peer)).toEqual(
    new Set([
      'LFM2-1.2B-Q6_K.gguf',
      'Big-Q4_K-00001-of-00002.gguf',
      'Big-Q4_K-00002-of-00002.gguf',
    ]),
  );
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
