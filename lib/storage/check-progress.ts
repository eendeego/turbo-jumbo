// Shared client helper for reading the /api/v1/copy/check NDJSON stream. The
// check emits one `progress` frame per file/destination pair it examines and a
// final `result` frame; hashing a pair whose sidecars can't answer reads the
// whole file, so the frames are what keeps the UI honest about the wait.

import {readNdjson} from '@/lib/util/ndjson';

export interface CheckProgress {
  done: number;
  total: number;
  file: string;
  // True while both copies of `file` are being read to compare md5s — the slow
  // path, taken only when the sidecars have no usable SHA256 for them.
  hashing: boolean;
}

/**
 * What the Copy button says while a check runs. Counting pairs only becomes
 * meaningful once the first frame lands, and "Verifying" marks the stretch
 * that reads whole files — the one actually worth waiting through.
 */
export function checkStatusLabel(progress?: CheckProgress | null): string {
  if (!progress || progress.total === 0) return 'Checking…';
  const verb = progress.hashing ? 'Verifying' : 'Checking';
  const at = Math.min(progress.done + 1, progress.total);
  return `${verb} ${at}/${progress.total}…`;
}

export interface ConflictCheckResult<C, F> {
  conflicts: C[];
  files: F[];
}

type Frame<C, F> =
  | ({type: 'progress'} & CheckProgress)
  | ({type: 'result'} & ConflictCheckResult<C, F>);

/**
 * Read the check stream to completion, reporting progress as it goes. Resolves
 * with the final result, or null when the stream ended without one — which is
 * what an aborted check looks like from here.
 */
export async function readCheckStream<C, F>(
  res: Response,
  onProgress: (p: CheckProgress) => void,
): Promise<ConflictCheckResult<C, F> | null> {
  let result: ConflictCheckResult<C, F> | null = null;
  await readNdjson<Frame<C, F>>(res, (frame) => {
    if (frame.type === 'progress') {
      const {done, total, file, hashing} = frame;
      onProgress({done, total, file, hashing});
    } else if (frame.type === 'result') {
      result = {conflicts: frame.conflicts, files: frame.files};
    }
  });
  return result;
}
