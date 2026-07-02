import {createHash} from 'crypto';
import {createReadStream, createWriteStream, promises as fsp} from 'fs';
import path from 'path';
import {pipeline} from 'stream/promises';

/**
 * SHA256 of a file streamed in-process, so `onBytes` can report progress chunk
 * by chunk (the multi-GB hash is the slow part of an audit). With `end` set,
 * hashes only bytes `0..end` inclusive (a prefix); otherwise the whole file.
 * Rejects when `signal` aborts mid-read.
 */
async function streamHash(
  fullPath: string,
  opts: {
    end?: number;
    signal?: AbortSignal;
    onBytes?: (n: number) => void;
  } = {},
): Promise<string> {
  const {end, signal, onBytes} = opts;
  const hash = createHash('sha256');
  const rs =
    end === undefined
      ? createReadStream(fullPath)
      : createReadStream(fullPath, {start: 0, end});
  if (onBytes) rs.on('data', (chunk: Buffer | string) => onBytes(chunk.length));
  await pipeline(rs, hash, {signal});
  return hash.digest('hex');
}

/** SHA256 of a whole file (see `streamHash`). */
export function localSha256(
  fullPath: string,
  signal?: AbortSignal,
  onBytes?: (n: number) => void,
): Promise<string> {
  return streamHash(fullPath, {signal, onBytes});
}

/** SHA256 of the first `length` bytes of a file (see `streamHash`). */
function sha256Region(
  fullPath: string,
  length: number,
  onBytes?: (n: number) => void,
): Promise<string> {
  return streamHash(fullPath, {end: length - 1, onBytes});
}

/**
 * Where a copy of `srcFull` to `dstFull` may resume: when the destination
 * already holds a prefix of the source — same bytes, verified by hashing the
 * partial file against the same-length region of the source — the copy can
 * skip those bytes and append the rest. Returns 0 (copy from scratch) when the
 * destination is absent, empty, longer than the source, or differs.
 *
 * Hashing a large partial is slow disk I/O; `onVerify` reports its progress as
 * (hashed, total) byte counts — total covers both files, i.e. twice the
 * partial's size. It is only called when a partial actually gets hashed, so a
 * caller can also use it to tell "no partial found" apart from "hashes
 * compared".
 */
export async function resumeOffset(
  srcFull: string,
  dstFull: string,
  onVerify?: (hashedBytes: number, totalBytes: number) => void,
): Promise<number> {
  let dstSize: number;
  try {
    dstSize = (await fsp.stat(dstFull)).size;
  } catch {
    return 0;
  }
  if (dstSize === 0) return 0;
  const srcSize = (await fsp.stat(srcFull)).size;
  if (dstSize > srcSize) return 0;
  let hashed = 0;
  const total = dstSize * 2;
  const onBytes =
    onVerify &&
    ((n: number) => {
      hashed += n;
      onVerify(hashed, total);
    });
  const [dstSha, srcSha] = await Promise.all([
    sha256Region(dstFull, dstSize, onBytes),
    sha256Region(srcFull, dstSize, onBytes),
  ]);
  return dstSha === srcSha ? dstSize : 0;
}

/**
 * Resume-aware stream copy of one file's bytes from `srcFull` to `dstFull`,
 * creating intermediate directories. Unlike a rename this works across
 * filesystems, so it backs the local → cold-storage transfer and the copy
 * route. A destination left behind by an interrupted copy is resumed rather
 * than recopied: the verified prefix is kept and only the tail streams (see
 * `resumeOffset`). Returns the resume offset — 0 when copied from scratch, >0
 * when a prefix was kept.
 *
 * Progress hooks, all optional: `onVerify` reports the resume-hash progress
 * (the slow part of a resume); `onResume` fires once the offset is decided,
 * before any streaming, so a caller can account for the skipped prefix and
 * switch its own progress phase; `onChunk` reports each streamed chunk's size
 * (the prefix is *not* reported here — `onResume`'s offset covers it). Aborts
 * with `signal`.
 */
export async function streamCopyResumable(
  srcFull: string,
  dstFull: string,
  hooks: {
    signal?: AbortSignal;
    onVerify?: (hashedBytes: number, totalBytes: number) => void;
    onResume?: (offset: number) => void;
    onChunk?: (n: number) => void;
  } = {},
): Promise<number> {
  const {signal, onVerify, onResume, onChunk} = hooks;
  await fsp.mkdir(path.dirname(dstFull), {recursive: true});
  const offset = await resumeOffset(srcFull, dstFull, onVerify);
  onResume?.(offset);
  const srcSize = (await fsp.stat(srcFull)).size;
  // Skip the stream only when a resume found the destination already complete;
  // offset 0 always streams, so an empty source still creates its destination.
  if (offset === 0 || offset < srcSize) {
    const rs = createReadStream(srcFull, {start: offset});
    if (onChunk)
      rs.on('data', (chunk: Buffer | string) => onChunk(chunk.length));
    // Append on resume; otherwise truncate whatever partial mismatch is there.
    const ws = createWriteStream(dstFull, offset > 0 ? {flags: 'a'} : {});
    await pipeline(rs, ws, {signal});
  }
  return offset;
}
