import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {readSafetensorsDtype} from '@/lib/safetensors';

// Build a minimal valid safetensors file: u64-LE header length, JSON header,
// then `dataBytes` of (zero) tensor data.
function safetensorsBytes(
  header: Record<string, unknown>,
  dataBytes = 0,
): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([len, json, Buffer.alloc(dataBytes)]);
}

test('reads the first tensor dtype, skipping __metadata__', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-st-'));
  const f = path.join(dir, 'model.safetensors');
  await fsp.writeFile(
    f,
    safetensorsBytes(
      {
        __metadata__: {format: 'pt'},
        weight: {dtype: 'BF16', shape: [2], data_offsets: [0, 4]},
      },
      4,
    ),
  );
  expect(await readSafetensorsDtypeAsync(f)).toBe('BF16');
  await fsp.rm(dir, {recursive: true, force: true});
});

test('uppercases lowercase dtypes', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-st-'));
  const f = path.join(dir, 'model.safetensors');
  await fsp.writeFile(
    f,
    safetensorsBytes({t: {dtype: 'f16', shape: [1], data_offsets: [0, 2]}}, 2),
  );
  expect(await readSafetensorsDtypeAsync(f)).toBe('F16');
  await fsp.rm(dir, {recursive: true, force: true});
});

test('returns null for a too-short or garbage file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-st-'));
  const tiny = path.join(dir, 'tiny.safetensors');
  await fsp.writeFile(tiny, Buffer.alloc(4)); // < 8 header bytes
  expect(await readSafetensorsDtypeAsync(tiny)).toBeNull();

  const garbage = path.join(dir, 'garbage.safetensors');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(5n);
  await fsp.writeFile(garbage, Buffer.concat([len, Buffer.from('xxxxx')]));
  expect(await readSafetensorsDtypeAsync(garbage)).toBeNull();

  expect(await readSafetensorsDtypeAsync(path.join(dir, 'nope'))).toBeNull();
  await fsp.rm(dir, {recursive: true, force: true});
});

// readSafetensorsDtype is sync; this thin wrapper keeps the tests readable.
async function readSafetensorsDtypeAsync(p: string): Promise<string | null> {
  return readSafetensorsDtype(p);
}
