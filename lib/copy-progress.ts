// Shared client helper for reading the /api/v1/copy NDJSON progress stream.
// The copy route streams one JSON object per line as work advances.

import type {Model} from '@/lib/model-types';
import {shardPath, shardSize} from '@/lib/model-types';

export interface CopyProgress {
  filesDone: number;
  filesTotal: number;
  fileDone: number; // bytes written for the current file
  fileTotal: number; // size of the current file in bytes
  bytesDone: number; // bytes written across all destinations so far
  bytesTotal: number; // total bytes to write across all destinations
}

// Map each file's storage-relative path to its byte size, so the copy route
// can report byte-level progress even when the source is a remote peer (whose
// files this server can't stat). Split shards report their individual sizes.
export function buildFileSizes(models: Model[]): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const model of models) {
    for (const mf of model.files) {
      if (mf.isSplit) {
        for (const f of mf.files) {
          const p = shardPath(f);
          if (p) sizes[p] = shardSize(f);
        }
      } else {
        sizes[mf.path] = mf.size;
      }
    }
  }
  return sizes;
}

// Read the newline-delimited JSON body of a copy response, invoking onProgress
// for each event. Resolves when the stream ends.
export async function readCopyProgress(
  res: Response,
  onProgress: (p: CopyProgress) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += dec.decode(value, {stream: true});
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) onProgress(JSON.parse(line) as CopyProgress);
    }
  }
}
