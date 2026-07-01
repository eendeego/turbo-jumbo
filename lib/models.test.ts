import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  duplicateBasenames,
  extractModelName,
  extractQuant,
  scanModels,
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
