import {useRef, useState} from 'react';
import type {FlmModel} from '@/lib/lemonade/flm';

// One progress frame of a Lemonade-server download (its /pull SSE events).
export interface FlmProgress {
  file: string;
  percent: number;
  bytesDownloaded: number;
  bytesTotal: number;
  fileIndex: number;
  totalFiles: number;
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/**
 * The FLM download flow: ask the target peer's Lemonade server to pull the
 * model (the flm binary fetches into that server's own store — the bytes
 * never touch Turbo Jumbo storage) and follow its SSE progress relayed by
 * /api/v1/lemonade/flm/pull. `model` is set while the progress view should
 * replace the catalog; closing mid-download cancels it (the server treats
 * the dropped stream as a cancel).
 */
export function useFlmDownload({
  peerSlug,
  onDone,
}: {
  // How the FLM endpoints name the target peer.
  peerSlug: string | null;
  onDone?: () => void;
}) {
  const [model, setModel] = useState<FlmModel | null>(null);
  const [progress, setProgress] = useState<FlmProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Whether the server itself lists the model as downloaded after the pull:
  // its SSE stream reports complete even when the flm binary quietly fetched
  // nothing (an unhealthy NPU setup), so completion alone can't be trusted.
  // null while unknown (still running, or the confirmation fetch failed).
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = async (m: FlmModel) => {
    if (running || !peerSlug) return;
    setModel(m);
    setProgress(null);
    setError(null);
    setConfirmed(null);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch('/api/v1/lemonade/flm/pull', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({peer: peerSlug, model: m.name}),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let completed = false;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event === 'error' || typeof payload.error === 'string')
            throw new Error(
              typeof payload.error === 'string'
                ? payload.error
                : 'Download failed',
            );
          setProgress({
            file: typeof payload.file === 'string' ? payload.file : '',
            percent: num(payload.percent),
            bytesDownloaded: num(payload.bytes_downloaded),
            bytesTotal: num(payload.bytes_total),
            fileIndex: num(payload.file_index),
            totalFiles: num(payload.total_files),
          });
          if (event === 'complete') completed = true;
        }
      }
      // A stream that ends without the complete event died mid-download
      // (server restart, network drop) — surface it rather than looking done.
      if (!completed) throw new Error('Download ended before completing.');
      // Ask the server whether it now counts the model as downloaded — the
      // one signal that the weights actually landed in its store.
      try {
        const check = await fetch(`/api/v1/lemonade/flm?peer=${peerSlug}`);
        if (check.ok) {
          const data = (await check.json()) as {models?: FlmModel[]};
          const entry = data.models?.find((x) => x.name === m.name);
          if (entry) setConfirmed(entry.downloaded);
        }
      } catch {
        /* confirmation unavailable: stay at null (unverified), not failed */
      }
    } catch (e) {
      if (!ac.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  // Cancel (when still running) or dismiss the progress view. Either way the
  // catalog returns and the parent refreshes its FLM list — a cancelled pull
  // may still have flipped state on the Lemonade server.
  const close = () => {
    abortRef.current?.abort();
    setModel(null);
    setProgress(null);
    setError(null);
    setConfirmed(null);
    setRunning(false);
    onDone?.();
  };

  return {model, progress, error, running, confirmed, start, close};
}
