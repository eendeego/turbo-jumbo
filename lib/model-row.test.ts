import {test, expect} from 'bun:test';
import {
  augmentWithPeerOnlyQuants,
  buildDisplayRows,
  type ModelRow,
  type QuantInfo,
} from '@/lib/model-row';
import type {Model} from '@/lib/model-types';
import type {FileProvenance, SidecarSummary} from '@/lib/model-sidecar';
import {AsyncState} from '@/lib/async-state';

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

test('buildDisplayRows puts the sidecar summary on the depth-0 row only', () => {
  const sidecar: SidecarSummary = {
    repoId: 'org/repo',
    modelUrl: 'https://huggingface.co/org/repo',
    sourceCommit: 'abc123',
    fileCount: 2,
    totalSourceSize: 200,
  };
  const rows = buildDisplayRows({
    ...noPeers,
    expanded: new Set(['org/repo']),
    models: [
      model({name: 'org/repo', quants: [quant({label: 'Q4_K_M'})], sidecar}),
    ],
  });
  const modelRow = rows.find((r) => r.depth === 0);
  const quantRow = rows.find((r) => r.depth === 1);
  expect(modelRow!.sidecar).toBe(sidecar);
  expect(quantRow!.sidecar).toBeUndefined();
});

test('buildDisplayRows copies single-file quant provenance onto the quant row', () => {
  const prov: FileProvenance = {
    originUrl: 'https://huggingface.co/org/repo/blob/main/Q4.gguf',
    sourceCommit: 'abc',
    sourceSize: 100,
    computedSize: 100,
    sourceSha256: 'aa',
    computedSha256: 'aa',
  };
  const rows = buildDisplayRows({
    ...noPeers,
    expanded: new Set(['org/repo']),
    models: [
      model({
        name: 'org/repo',
        quants: [quant({label: 'Q4', provenance: prov})],
      }),
    ],
  });
  const quantRow = rows.find((r) => r.depth === 1);
  expect(quantRow!.provenance).toBe(prov);
});

test('two models sharing a repo name get an org suffix; a unique repo name does not', () => {
  const rows = buildDisplayRows({
    ...noPeers,
    models: [
      model({name: 'alpha/Repo', quants: [quant({label: 'Q4'})]}),
      model({name: 'beta/Repo', quants: [quant({label: 'Q4'})]}),
      model({name: 'gamma/Other', quants: [quant({label: 'Q4'})]}),
    ],
  });
  expect(rows[0]).toMatchObject({label: 'alpha/Repo', orgSuffix: 'alpha'});
  expect(rows[1]).toMatchObject({label: 'beta/Repo', orgSuffix: 'beta'});
  expect(rows[2].orgSuffix).toBeUndefined();
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

test('a quant whose cold copy is smaller than a peer copy is flagged coldIncomplete', () => {
  // Cold holds a truncated copy (50); a peer holds the complete one (100). The
  // row built from cold would call itself complete, so the peer's larger size is
  // what reveals the cold backup is incomplete.
  const q = quant({
    label: 'Q4',
    size: 50,
    coldTotalSize: 50,
    inColdStorage: true,
    coldSize: 50,
    coldComplete: true,
  });
  const rows = buildDisplayRows({
    ...noPeers,
    expanded: new Set(['org/repo']),
    peerQuantSizes: new Map([
      ['org/repo::Q4.gguf', [{address: '192.0.2.2:3000', size: 100}]],
    ]),
    peerNameByAddr: new Map([['192.0.2.2:3000', 'my-server']]),
    models: [model({name: 'org/repo', quants: [q]})],
  });
  const modelRow = rows.find((r) => r.depth === 0)!;
  const quantRow = rows.find((r) => r.depth === 1)!;
  expect(quantRow.undersizedLocations.has('cold-storage')).toBe(true);
  expect(quantRow.coldIncomplete).toBe(true);
  expect(modelRow.coldIncomplete).toBe(true);
});

test('a quant whose cold copy matches the largest copy is not coldIncomplete', () => {
  const q = quant({
    label: 'Q4',
    size: 100,
    coldTotalSize: 100,
    inColdStorage: true,
    coldSize: 100,
    coldComplete: true,
  });
  const rows = buildDisplayRows({
    ...noPeers,
    expanded: new Set(['org/repo']),
    peerQuantSizes: new Map([
      ['org/repo::Q4.gguf', [{address: '192.0.2.2:3000', size: 100}]],
    ]),
    peerNameByAddr: new Map([['192.0.2.2:3000', 'my-server']]),
    models: [model({name: 'org/repo', quants: [q]})],
  });
  expect(rows.find((r) => r.depth === 1)!.coldIncomplete).toBe(false);
  expect(rows.find((r) => r.depth === 0)!.coldIncomplete).toBe(false);
});

function peerModel(name: string, files: Model['files']): Model {
  return {name, files};
}

test('a peer copy of a local file is not re-added as a duplicate peer-only row', () => {
  // The local table names the GGUF from its filename (no sidecar); the peer
  // names the same file by its repo. They share one path, so a duplicate row
  // would make the file selectable under two rows that toggle together.
  const local = model({
    name: 'gemma-3-4b-it',
    quants: [
      quant({
        label: 'Q4_K_M',
        filename: 'gemma-3-4b-it-Q4_K_M.gguf',
        displayName: 'gemma-3-4b-it-Q4_K_M.gguf',
        paths: ['ggml-org/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf'],
      }),
    ],
  });
  const peers = new Map([
    [
      '192.0.2.2:3000',
      AsyncState.value([
        peerModel('ggml-org/gemma-3-4b-it-GGUF', [
          {
            isSplit: false,
            filename: 'gemma-3-4b-it-Q4_K_M.gguf',
            path: 'ggml-org/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf',
            quant: 'Q4_K_M',
            size: 100,
            missing: false,
          },
        ]),
      ]),
    ],
  ]);
  const augmented = augmentWithPeerOnlyQuants([local], peers);
  expect(augmented.map((m) => m.name)).toEqual(['gemma-3-4b-it']);
});

test('a peer model with no local counterpart still gets its own row', () => {
  const local = model({
    name: 'gemma-3-4b-it',
    quants: [
      quant({
        label: 'Q4_K_M',
        paths: ['ggml-org/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf'],
      }),
    ],
  });
  const peers = new Map([
    [
      '192.0.2.2:3000',
      AsyncState.value([
        peerModel('other-org/Llama-3-8B-GGUF', [
          {
            isSplit: false,
            filename: 'Llama-3-8B-Q8_0.gguf',
            path: 'other-org/Llama-3-8B-GGUF/Llama-3-8B-Q8_0.gguf',
            quant: 'Q8_0',
            size: 200,
            missing: false,
          },
        ]),
      ]),
    ],
  ]);
  const augmented = augmentWithPeerOnlyQuants([local], peers);
  expect(augmented.map((m) => m.name).sort()).toEqual([
    'gemma-3-4b-it',
    'other-org/Llama-3-8B-GGUF',
  ]);
});

test('a peer-only file of a shared model joins the existing row, not a new one', () => {
  // my-server has the gemma repo with the Q4_K_M (shared with local) plus an
  // mmproj the local copy lacks. The mmproj must land on the local
  // `gemma-3-4b-it` row, not open a second `ggml-org/...` row for one file.
  const local = model({
    name: 'gemma-3-4b-it',
    quants: [
      quant({
        label: 'Q4_K_M',
        filename: 'gemma-3-4b-it-Q4_K_M.gguf',
        displayName: 'gemma-3-4b-it-Q4_K_M.gguf',
        paths: ['ggml-org/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf'],
      }),
    ],
  });
  const peers = new Map([
    [
      '192.0.2.2:3000',
      AsyncState.value([
        peerModel('ggml-org/gemma-3-4b-it-GGUF', [
          {
            isSplit: false,
            filename: 'gemma-3-4b-it-Q4_K_M.gguf',
            path: 'ggml-org/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf',
            quant: 'Q4_K_M',
            size: 100,
            missing: false,
          },
          {
            isSplit: false,
            filename: 'mmproj-model-f16.gguf',
            path: 'ggml-org/gemma-3-4b-it-GGUF/mmproj-model-f16.gguf',
            quant: 'F16',
            size: 50,
            missing: false,
          },
        ]),
      ]),
    ],
  ]);
  const augmented = augmentWithPeerOnlyQuants([local], peers);
  expect(augmented.map((m) => m.name)).toEqual(['gemma-3-4b-it']);
  const labels = augmented[0].quants.map((q) => q.label).sort();
  expect(labels).toEqual(['Q4_K_M', 'mmproj-model-f16.gguf']);
});
