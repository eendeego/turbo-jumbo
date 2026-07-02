// Consume an NDJSON response, parsing each line and handing it to `onEvent`
// as it arrives.
export async function readNdjson<T>(
  res: Response,
  onEvent: (event: T) => void,
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
      if (line.trim()) onEvent(JSON.parse(line) as T);
    }
  }
}
