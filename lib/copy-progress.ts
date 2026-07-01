// Shared client helper for reading the /api/v1/copy NDJSON progress stream.
// The copy route streams one JSON object per line as work advances.

import type {Model} from '@/lib/model-types';
import {shardPath, shardSize} from '@/lib/model-types';
import {readNdjson} from '@/lib/ndjson';

export interface CopyProgress {
  filesDone: number;
  filesTotal: number;
  fileDone: number; // bytes written for the current file
  fileTotal: number; // size of the current file in bytes
  bytesDone: number; // bytes written across all destinations so far
  bytesTotal: number; // total bytes to write across all destinations
  // Pre-copy verification of a partial destination (resumable copies):
  // while phase is 'verifying', verifyDone/verifyTotal track the SHA256
  // hashing; `resume` then records the outcome for the current file.
  phase?: 'verifying' | 'copying';
  verifyDone?: number;
  verifyTotal?: number;
  resume?: 'resumed' | 'from-start' | null;
  // Per-(file, destination) failures collected during the run. A non-empty
  // list means the copy finished with partial success; the client surfaces it.
  errors?: string[];
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
export function readCopyProgress(
  res: Response,
  onProgress: (p: CopyProgress) => void,
): Promise<void> {
  return readNdjson<CopyProgress>(res, onProgress);
}

// Run the copy progress stream to completion, then surface any per-file
// failures it collected: the stream finishes even on partial success (a file
// or destination failing no longer aborts the whole run), so the final frame's
// `errors` list is how the client learns about them.
export async function readCopyAndReportErrors(
  res: Response,
  onProgress: (p: CopyProgress) => void,
  onError: (msg: string) => void,
): Promise<void> {
  const box: {last: CopyProgress | null} = {last: null};
  await readNdjson<CopyProgress>(res, (p) => {
    box.last = p;
    onProgress(p);
  });
  if (box.last?.errors && box.last.errors.length > 0) {
    onError(`Some files failed to copy:\n${box.last.errors.join('\n')}`);
  }
}
