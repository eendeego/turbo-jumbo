// Shared client helper for reading the /api/v1/copy NDJSON progress stream.
// The copy route streams one JSON object per line as work advances.

export interface CopyProgress {
  done: number;
  total: number;
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
