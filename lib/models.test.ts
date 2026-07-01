import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  duplicateBasenames,
  extractModelName,
  extractQuant,
  normalizeModelNames,
  scanModels,
  type Model,
  type SingleFile,
} from '@/lib/models';
import {writeMeta} from '@/lib/audit';

async function writeFile(base: string, rel: string, content = 'data') {
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, content);
  return full;
}

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

test('scanModels groups a file by its sidecar org/repo when present', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-scan-'));
  const file = await writeFile(
    base,
    'unsloth/Qwen3.6-35B-A3B-MTP-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
  );
  await writeMeta(file, {
    modelUrl: 'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    originUrl:
      'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF/blob/main/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
    sourceSha256: 's',
    computedSha256: 's',
  });

  const models = scanModels(base);
  expect(models.map((m) => m.name)).toEqual([
    'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
  ]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('scanModels falls back to the filename-derived name without a sidecar', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-scan-'));
  await writeFile(base, 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf');

  const models = scanModels(base);
  expect(models.map((m) => m.name)).toEqual(['Qwen3.6-35B-A3B']);
  await fsp.rm(base, {recursive: true, force: true});
});

test('scanModels splits same-filename variants by their sidecar repos', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-scan-'));
  const fname = 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf';
  for (const repo of [
    'unsloth/Qwen3.6-35B-A3B-GGUF',
    'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
  ]) {
    const f = await writeFile(base, `${repo}/${fname}`);
    await writeMeta(f, {
      modelUrl: `https://huggingface.co/${repo}`,
      originUrl: `https://huggingface.co/${repo}/blob/main/${fname}`,
      sourceSha256: 's',
      computedSha256: 's',
    });
  }

  const names = scanModels(base)
    .map((m) => m.name)
    .sort();
  expect(names).toEqual([
    'unsloth/Qwen3.6-35B-A3B-GGUF',
    'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
  ]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('duplicateBasenames ignores same-named files in different cache repos', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dup-'));
  await writeFile(
    base,
    'models--org-a--Model-GGUF/snapshots/r1/model.safetensors',
  );
  await writeFile(
    base,
    'models--org-b--Other-GGUF/snapshots/r2/model.safetensors',
  );

  const dups = duplicateBasenames(scanModels(base));
  expect([...dups.keys()]).toEqual([]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('scanModels names a cache-layout file by its decoded repo id', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-scan-'));
  await writeFile(
    base,
    'models--unsloth--Qwen3-0.6B-GGUF/snapshots/abc123/Qwen3-0.6B-Q4_0.gguf',
  );

  const models = scanModels(base);
  expect(models.map((m) => m.name)).toEqual(['unsloth/Qwen3-0.6B-GGUF']);
  await fsp.rm(base, {recursive: true, force: true});
});

test('scanModels ignores the cache blobs and refs entries', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-scan-'));
  await writeFile(
    base,
    'models--unsloth--Qwen3-0.6B-GGUF/snapshots/abc123/Qwen3-0.6B-Q4_0.gguf',
  );
  await writeFile(base, 'models--unsloth--Qwen3-0.6B-GGUF/refs/main', 'abc123');
  // A blob file: no model extension, so it must not become its own model.
  await writeFile(base, 'models--unsloth--Qwen3-0.6B-GGUF/blobs/deadbeef');

  const models = scanModels(base);
  expect(models.map((m) => m.name)).toEqual(['unsloth/Qwen3-0.6B-GGUF']);
  expect(models[0].files).toHaveLength(1);
  await fsp.rm(base, {recursive: true, force: true});
});

test('scanModels groups sharded safetensors into one split group', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-scan-'));
  const repo = 'models--unsloth--Big-Model/snapshots/r1';
  for (let i = 1; i <= 4; i++) {
    const n = String(i).padStart(5, '0');
    await writeFile(base, `${repo}/model-${n}-of-00004.safetensors`);
  }

  const models = scanModels(base);
  expect(models.map((m) => m.name)).toEqual(['unsloth/Big-Model']);
  const file = models[0].files[0];
  expect(file.isSplit).toBe(true);
  if (file.isSplit) {
    expect(file.totalShards).toBe(4);
    expect(file.presentShards).toBe(4);
    expect(file.missingIndices).toEqual([]);
    expect(file.files).toHaveLength(4);
  }
  await fsp.rm(base, {recursive: true, force: true});
});

test('scanModels reports a missing safetensors shard', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-scan-'));
  const repo = 'models--unsloth--Big-Model/snapshots/r1';
  // Shards 1, 2, 4 present; 3 missing.
  for (const i of [1, 2, 4]) {
    const n = String(i).padStart(5, '0');
    await writeFile(base, `${repo}/model-${n}-of-00004.safetensors`);
  }

  const file = scanModels(base)[0].files[0];
  expect(file.isSplit).toBe(true);
  if (file.isSplit) {
    expect(file.presentShards).toBe(3);
    expect(file.missingIndices).toEqual([3]);
  }
  await fsp.rm(base, {recursive: true, force: true});
});

function safetensorsBytes(dtype: string): Buffer {
  const json = Buffer.from(
    JSON.stringify({weight: {dtype, shape: [1], data_offsets: [0, 2]}}),
    'utf8',
  );
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([len, json, Buffer.alloc(2)]);
}

test('scanModels labels a generic safetensors by its header dtype', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-scan-'));
  const full = path.join(
    base,
    'models--unsloth--Small-Model/snapshots/r1/model.safetensors',
  );
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, safetensorsBytes('BF16'));

  const file = scanModels(base)[0].files[0];
  expect(file.quant).toBe('BF16');
  await fsp.rm(base, {recursive: true, force: true});
});

test('scanModels labels sharded safetensors by the first shard dtype', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-scan-'));
  const dir = path.join(base, 'models--unsloth--Big-Model/snapshots/r1');
  await fsp.mkdir(dir, {recursive: true});
  for (let i = 1; i <= 2; i++) {
    const n = String(i).padStart(5, '0');
    await fsp.writeFile(
      path.join(dir, `model-${n}-of-00002.safetensors`),
      safetensorsBytes('F16'),
    );
  }

  const file = scanModels(base)[0].files[0];
  expect(file.quant).toBe('F16');
  await fsp.rm(base, {recursive: true, force: true});
});

test('scanModels keeps a filename quant token over the header', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-scan-'));
  const full = path.join(
    base,
    'models--unsloth--Tok-Model/snapshots/r1/model-Q4_K_M.safetensors',
  );
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, safetensorsBytes('F32')); // header differs from token
  const file = scanModels(base)[0].files[0];
  expect(file.quant).toBe('Q4_K_M');
  await fsp.rm(base, {recursive: true, force: true});
});

test('duplicateBasenames flags a root copy and a nested copy of the same file', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dup-'));
  const fname = 'gemma-4-26B-A4B-it-UD-IQ2_M.gguf';
  await writeFile(base, fname);
  await writeFile(base, `unsloth/gemma-4-26B-A4B-it-GGUF/${fname}`);
  await writeFile(base, 'unsloth/other-GGUF/other-Q8_0.gguf');

  const dups = duplicateBasenames(scanModels(base));
  expect([...dups.keys()]).toEqual([fname]);
  expect(dups.get(fname)!.sort()).toEqual([
    fname,
    `unsloth/gemma-4-26B-A4B-it-GGUF/${fname}`,
  ]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('duplicateBasenames lists all three copies of a thrice-duplicated file', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dup-'));
  const fname = 'My-Model-Q4_K_M.gguf';
  await writeFile(base, fname);
  await writeFile(base, `a/${fname}`);
  await writeFile(base, `b/c/${fname}`);

  const dups = duplicateBasenames(scanModels(base));
  expect(dups.get(fname)!.sort()).toEqual([
    fname,
    `a/${fname}`,
    `b/c/${fname}`,
  ]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('duplicateBasenames is empty when every filename is unique', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dup-'));
  await writeFile(base, 'A-Q4_K_M.gguf');
  await writeFile(base, 'sub/B-Q4_K_M.gguf');

  expect(duplicateBasenames(scanModels(base)).size).toBe(0);
  await fsp.rm(base, {recursive: true, force: true});
});

test('duplicateBasenames detects colliding split shards but not a lone split group', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dup-'));
  await writeFile(base, 'M-Q4_K_M-00001-of-00002.gguf');
  await writeFile(base, 'M-Q4_K_M-00002-of-00002.gguf');
  await writeFile(base, 'sub/M-Q4_K_M-00001-of-00002.gguf');

  const dups = duplicateBasenames(scanModels(base));
  expect([...dups.keys()]).toEqual(['M-Q4_K_M-00001-of-00002.gguf']);
  expect(dups.get('M-Q4_K_M-00001-of-00002.gguf')!.sort()).toEqual([
    'M-Q4_K_M-00001-of-00002.gguf',
    'sub/M-Q4_K_M-00001-of-00002.gguf',
  ]);
  await fsp.rm(base, {recursive: true, force: true});
});

// --- normalizeModelNames ---

function single(filename: string, p: string, size = 100): SingleFile {
  return {
    isSplit: false,
    filename,
    path: p,
    quant: 'Q4_K_M',
    size,
    missing: false,
  };
}

test('normalizeModelNames renames a filename-derived model to its sidecar repo name', () => {
  // The local copy was audited (sidecar names the repo); the cold copy has no
  // sidecar, so its scan derived the name from the filename.
  const local: Model[] = [
    {
      name: 'unsloth/gpt-oss-20b-GGUF',
      files: [
        single(
          'gpt-oss-20b-Q4_K_M.gguf',
          'unsloth/gpt-oss-20b-GGUF/gpt-oss-20b-Q4_K_M.gguf',
        ),
      ],
    },
  ];
  const cold: Model[] = [
    {
      name: 'gpt-oss-20b',
      files: [single('gpt-oss-20b-Q4_K_M.gguf', 'gpt-oss-20b-Q4_K_M.gguf')],
    },
  ];

  const [l, c] = normalizeModelNames([local, cold]);
  expect(l.map((m) => m.name)).toEqual(['unsloth/gpt-oss-20b-GGUF']);
  expect(c.map((m) => m.name)).toEqual(['unsloth/gpt-oss-20b-GGUF']);
});

test('normalizeModelNames merges same-named models within one scan after renaming', () => {
  const local: Model[] = [
    {
      name: 'unsloth/LFM2-1.2B-GGUF',
      files: [
        single(
          'LFM2-1.2B-Q2_K.gguf',
          'unsloth/LFM2-1.2B-GGUF/LFM2-1.2B-Q2_K.gguf',
        ),
      ],
    },
    {
      name: 'LFM2-1.2B',
      files: [single('LFM2-1.2B-Q6_K.gguf', 'LFM2-1.2B-Q6_K.gguf')],
    },
  ];

  const [l] = normalizeModelNames([local]);
  expect(l).toHaveLength(1);
  expect(l[0].name).toBe('unsloth/LFM2-1.2B-GGUF');
  expect(l[0].files.map((f) => (f as SingleFile).filename).sort()).toEqual([
    'LFM2-1.2B-Q2_K.gguf',
    'LFM2-1.2B-Q6_K.gguf',
  ]);
});

test('normalizeModelNames leaves a name alone when two repos claim it', () => {
  const local: Model[] = [
    {
      name: 'unsloth/My-Model-GGUF',
      files: [
        single(
          'My-Model-Q4_K_M.gguf',
          'unsloth/My-Model-GGUF/My-Model-Q4_K_M.gguf',
        ),
      ],
    },
    {
      name: 'bartowski/My-Model-GGUF',
      files: [
        single(
          'My-Model-Q4_K_M.gguf',
          'bartowski/My-Model-GGUF/My-Model-Q4_K_M.gguf',
        ),
      ],
    },
  ];
  const cold: Model[] = [
    {
      name: 'My-Model',
      files: [single('My-Model-Q4_K_M.gguf', 'My-Model-Q4_K_M.gguf')],
    },
  ];

  const [, c] = normalizeModelNames([local, cold]);
  expect(c.map((m) => m.name)).toEqual(['My-Model']);
});

test('normalizeModelNames derives the alias of a split group from its shard names', () => {
  const local: Model[] = [
    {
      name: 'unsloth/Big-MTP-GGUF',
      files: [
        {
          isSplit: true,
          representativeFilename: 'Big-Q4_K_M-00001-of-00002.gguf',
          files: [
            {
              path: 'unsloth/Big-MTP-GGUF/Big-Q4_K_M-00001-of-00002.gguf',
              size: 50,
            },
            {
              path: 'unsloth/Big-MTP-GGUF/Big-Q4_K_M-00002-of-00002.gguf',
              size: 50,
            },
          ],
          quant: 'Q4_K_M',
          totalShards: 2,
          presentShards: 2,
          missingIndices: [],
          totalSize: 100,
        },
      ],
    },
  ];
  const cold: Model[] = [
    {
      name: 'Big',
      files: [
        {
          isSplit: true,
          representativeFilename: 'Big-Q4_K_M-00001-of-00002.gguf',
          files: [
            {path: 'Big-Q4_K_M-00001-of-00002.gguf', size: 50},
            {path: 'Big-Q4_K_M-00002-of-00002.gguf', size: 50},
          ],
          quant: 'Q4_K_M',
          totalShards: 2,
          presentShards: 2,
          missingIndices: [],
          totalSize: 100,
        },
      ],
    },
  ];

  const [, c] = normalizeModelNames([local, cold]);
  expect(c.map((m) => m.name)).toEqual(['unsloth/Big-MTP-GGUF']);
});
