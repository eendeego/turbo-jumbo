import fs from 'fs';

// A safetensors header is JSON and small; cap the read so a corrupt length
// prefix can't ask us to allocate gigabytes.
const MAX_HEADER_BYTES = 100 * 1024 * 1024;

/**
 * The dominant tensor dtype of a `.safetensors` file (e.g. `BF16`, `F16`,
 * `F8_E4M3`), read from its header — the first 8 bytes are a little-endian
 * u64 header length, followed by that many bytes of JSON mapping tensor names
 * to `{dtype, …}`. Returns the first non-`__metadata__` tensor's dtype,
 * uppercased, or null when the file can't be read or isn't a valid
 * safetensors container. Synchronous to fit the synchronous scan; reads only
 * the header, not the (multi-GB) tensor data.
 */
export function readSafetensorsDtype(fullPath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(fullPath, 'r');
  } catch {
    return null;
  }
  try {
    const lenBuf = Buffer.alloc(8);
    if (fs.readSync(fd, lenBuf, 0, 8, 0) < 8) return null;
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (
      !Number.isSafeInteger(headerLen) ||
      headerLen <= 0 ||
      headerLen > MAX_HEADER_BYTES
    ) {
      return null;
    }
    const headerBuf = Buffer.alloc(headerLen);
    if (fs.readSync(fd, headerBuf, 0, headerLen, 8) < headerLen) return null;
    const header = JSON.parse(headerBuf.toString('utf8')) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(header)) {
      if (key === '__metadata__') continue;
      const dtype = (value as {dtype?: unknown}).dtype;
      if (typeof dtype === 'string' && dtype) return dtype.toUpperCase();
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
