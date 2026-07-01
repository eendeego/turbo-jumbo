import {test, expect} from 'bun:test';
import {
  allFilesPresent,
  fileJoinKey,
  peerFileKeys,
  withPeerPaths,
} from '@/lib/peer-paths';
import type {Model} from '@/lib/models';
import type {ModelRow, QuantInfo} from '@/lib/model-row';

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

test('peerFileKeys lists every specific basename on the peer', () => {
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

  // Specific (GGUF) basenames join on their own — the keys are the basenames.
  expect(peerFileKeys(peer)).toEqual(
    new Set([
      'LFM2-1.2B-Q6_K.gguf',
      'Big-Q4_K-00001-of-00002.gguf',
      'Big-Q4_K-00002-of-00002.gguf',
    ]),
  );
});

test('fileJoinKey qualifies generic weight names by model, not specific ones', () => {
  // A GGUF/dtype-tagged name identifies the model, so it joins on its own.
  expect(fileJoinKey('org/repo', 'Jan-nano-Q6_K.gguf')).toBe(
    'Jan-nano-Q6_K.gguf',
  );
  // A generic safetensors/bin name collides across repos, so it carries the
  // model name.
  expect(fileJoinKey('org/repo', 'model.safetensors')).not.toBe(
    'model.safetensors',
  );
  expect(fileJoinKey('org/repo', 'model.safetensors')).toBe(
    fileJoinKey('org/repo', 'model.safetensors'),
  );
  expect(fileJoinKey('a/b', 'model.safetensors')).not.toBe(
    fileJoinKey('c/d', 'model.safetensors'),
  );
  // Sharded generic names are qualified too.
  expect(fileJoinKey('a/b', 'model-00001-of-00002.safetensors')).not.toBe(
    fileJoinKey('c/d', 'model-00001-of-00002.safetensors'),
  );
});

test('withPeerPaths does not match a generic name across different repos', () => {
  const models = [
    row('org-a/Model', [quant('ST', ['org-a/Model/model.safetensors'])]),
  ];
  const peer: Model[] = [
    {
      name: 'org-b/Other',
      files: [
        {
          isSplit: false,
          filename: 'model.safetensors',
          path: 'org-b/Other/model.safetensors',
          quant: 'ST',
          size: 100,
          missing: false,
        },
      ],
    } as unknown as Model,
  ];

  // Different repo, same generic basename — the peer does not have this model,
  // so the local path is kept (not remapped to the peer's other file).
  const out = withPeerPaths(models, peer);
  expect(out[0].quants[0].paths).toEqual(['org-a/Model/model.safetensors']);
});

test('withPeerPaths matches a generic name within the same repo', () => {
  const models = [
    row('org-a/Model', [quant('ST', ['org-a/Model/model.safetensors'])]),
  ];
  const peer: Model[] = [
    {
      name: 'org-a/Model',
      files: [
        {
          isSplit: false,
          filename: 'model.safetensors',
          path: 'snapshots/r1/model.safetensors',
          quant: 'ST',
          size: 100,
          missing: false,
        },
      ],
    } as unknown as Model,
  ];

  const out = withPeerPaths(models, peer);
  expect(out[0].quants[0].paths).toEqual(['snapshots/r1/model.safetensors']);
});

test('peerFileKeys qualifies a generic name by its model', () => {
  const peer: Model[] = [
    {
      name: 'org-a/Model',
      files: [
        {
          isSplit: false,
          filename: 'model.safetensors',
          path: 'org-a/Model/model.safetensors',
          quant: 'ST',
          size: 100,
          missing: false,
        },
      ],
    } as unknown as Model,
  ];

  const keys = peerFileKeys(peer);
  expect(keys.has('model.safetensors')).toBe(false);
  expect(keys.has(fileJoinKey('org-a/Model', 'model.safetensors'))).toBe(true);
});

test('peerFileKeys qualifies an mmproj projector by its model', () => {
  const peer: Model[] = [
    {
      name: 'unsloth/A-GGUF',
      files: [
        {
          isSplit: false,
          filename: 'mmproj-F16.gguf',
          path: 'unsloth/A-GGUF/mmproj-F16.gguf',
          quant: 'F16',
          size: 100,
          missing: false,
        },
      ],
    } as unknown as Model,
  ];

  const keys = peerFileKeys(peer);
  expect(keys.has('mmproj-F16.gguf')).toBe(false);
  expect(keys.has('unsloth/A-GGUF mmproj-F16.gguf')).toBe(true);
});

test('fileJoinKey qualifies an mmproj projector by model name', () => {
  expect(fileJoinKey('unsloth/A-GGUF', 'mmproj-F16.gguf')).toBe(
    'unsloth/A-GGUF mmproj-F16.gguf',
  );
  expect(fileJoinKey('unsloth/A-GGUF', 'mmproj-F16.gguf')).not.toBe(
    fileJoinKey('unsloth/B-GGUF', 'mmproj-F16.gguf'),
  );
});

test('fileJoinKey leaves a specific gguf weight name unqualified', () => {
  expect(fileJoinKey('unsloth/A-GGUF', 'A-Q4_K_M.gguf')).toBe('A-Q4_K_M.gguf');
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

function file(filename: string, p = filename): Model['files'][number] {
  return {
    isSplit: false,
    filename,
    path: p,
    quant: 'F16',
    size: 100,
    missing: false,
  };
}

test("allFilesPresent does not match a projector against another model's mmproj", () => {
  // Selecting model A's projector while the destination only holds model B's
  // same-named projector must report "not present" — the generic basename
  // collides, so the join key has to be qualified by model.
  const dest: Model[] = [
    {
      name: 'unsloth/Model-B-GGUF',
      files: [file('mmproj-F16.gguf', 'unsloth/Model-B-GGUF/mmproj-F16.gguf')],
    },
  ];
  const selected = [
    {model: 'unsloth/Model-A-GGUF', filename: 'mmproj-F16.gguf'},
  ];
  expect(allFilesPresent(selected, dest)).toBe(false);
});

test("allFilesPresent matches a projector against the same model's mmproj", () => {
  const dest: Model[] = [
    {
      name: 'unsloth/Model-A-GGUF',
      files: [file('mmproj-F16.gguf', 'unsloth/Model-A-GGUF/mmproj-F16.gguf')],
    },
  ];
  const selected = [
    {model: 'unsloth/Model-A-GGUF', filename: 'mmproj-F16.gguf'},
  ];
  expect(allFilesPresent(selected, dest)).toBe(true);
});

test('allFilesPresent matches a specific gguf across differently-named hosts', () => {
  // A specific (non-generic) GGUF basename identifies its model, so it joins on
  // the basename alone — presence holds even when the hosts name the model
  // differently.
  const dest: Model[] = [
    {
      name: 'unsloth/Jan-nano-GGUF',
      files: [
        file('Jan-nano-Q6_K.gguf', 'unsloth/Jan-nano-GGUF/Jan-nano-Q6_K.gguf'),
      ],
    },
  ];
  const selected = [{model: 'Jan-nano', filename: 'Jan-nano-Q6_K.gguf'}];
  expect(allFilesPresent(selected, dest)).toBe(true);
});
