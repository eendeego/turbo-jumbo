'use client';

import {useRef, useState} from 'react';
import {Dialog} from '@astryxdesign/core/Dialog';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';

export type TermState = {lines: string[]; col: number};

export type DownloadProgress = {
  percent: number;
  downloaded: string;
  total: string;
  speed: string | null;
  eta: string | null;
  filesDone: number;
  filesTotal: number;
};

export type DownloadRequest = {
  repoId: string;
  branch: string;
  filePaths: string[];
  sendToCold?: boolean;
  deleteAfterTransfer?: boolean;
};

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  K: 1e3,
  MB: 1e6,
  M: 1e6,
  GB: 1e9,
  G: 1e9,
  TB: 1e12,
  T: 1e12,
};

function parseSize(s: string): number {
  const m = s.match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return 0;
  return parseFloat(m[1]) * (SIZE_UNITS[m[2].toUpperCase()] ?? 1);
}

// Apply a raw output chunk to the terminal buffer, honouring \r (carriage
// return) so progress lines redraw in place rather than stacking.
function applyChunk(state: TermState, chunk: string): TermState {
  const lines = [...state.lines];
  let col = state.col;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    if (ch === '\r') {
      if (chunk[i + 1] === '\n') {
        lines.push('');
        col = 0;
        i++;
      } else {
        col = 0;
      }
    } else if (ch === '\n') {
      lines.push('');
      col = 0;
    } else {
      const li = lines.length - 1;
      const line = lines[li];
      lines[li] =
        col < line.length
          ? line.slice(0, col) + ch + line.slice(col + 1)
          : line.padEnd(col, ' ') + ch;
      col++;
    }
  }
  return {lines, col};
}

function parseProgress(lines: string[]): DownloadProgress | null {
  let percent = 0;
  let downloaded = '';
  let total = '';
  let speed: string | null = null;
  let eta: string | null = null;
  let filesDone = 0;
  let filesTotal = 0;
  let hasDownload = false;

  for (const line of lines) {
    // "Downloading ...:   5% 523M/9.97G [00:12<04:39, 33.8MB/s]"
    const dl = line.match(
      /Downloading[^:]*:\s+(\d+)%\s+([\d.]+\s*\S+)\/([\d.]+\s*\S+)\s+\[([^\]]*)\]/,
    );
    if (dl) {
      hasDownload = true;
      percent = parseInt(dl[1], 10);
      downloaded = dl[2];
      total = dl[3];
      const meta = dl[4];
      const speedMatch = meta.match(/([\d.]+\s*\S+\/s)/);
      if (speedMatch) speed = speedMatch[1];
      const etaMatch = meta.match(/<([\d:]+)/);
      if (etaMatch) eta = etaMatch[1];
    }

    // "Fetching 1 files:   0% 0/1 [00:00<?, ?it/s]"
    const ft = line.match(/Fetching\s+\d+\s+files?:\s+\d+%\s+(\d+)\/(\d+)/);
    if (ft) {
      filesDone = parseInt(ft[1], 10);
      filesTotal = parseInt(ft[2], 10);
    }
  }

  if (!hasDownload) return null;
  return {percent, downloaded, total, speed, eta, filesDone, filesTotal};
}

/**
 * Drives a streaming `/api/v1/hf-download` run: posts the request, parses the
 * terminal output into a redrawing buffer and structured progress, and exposes
 * cancel/reset. Reused by the HF download box and the audit "Redownload" action.
 */
export function useDownloadRunner() {
  const [term, setTerm] = useState<TermState | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const start = async (req: DownloadRequest) => {
    if (running) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    setTerm({lines: [''], col: 0});
    setProgress(null);

    try {
      const res = await fetch('/api/v1/hf-download', {
        method: 'POST',
        signal: abort.signal,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(req),
      });

      if (!res.ok || !res.body) {
        setTerm({lines: [`Error: ${res.statusText}`], col: 0});
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let state: TermState = {lines: [''], col: 0};

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        state = applyChunk(state, decoder.decode(value, {stream: true}));
        setTerm({...state});
        const p = parseProgress(state.lines);
        if (p) setProgress(p);
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setTerm({lines: [`Error: ${String(e)}`], col: 0});
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const cancel = () => abortRef.current?.abort();
  const reset = () => {
    setTerm(null);
    setProgress(null);
  };

  return {term, progress, running, start, cancel, reset};
}

/** Streaming progress + terminal output dialog for a download run. */
export function DownloadModal({
  title = 'Downloading…',
  term,
  progress,
  running,
  onClose,
}: {
  title?: string;
  term: TermState | null;
  progress: DownloadProgress | null;
  running: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} purpose="form">
      <VStack gap={4}>
        <Heading level={3}>{title}</Heading>
        {progress && (
          <VStack gap={2}>
            <ProgressBar
              label="Download"
              value={parseSize(progress.downloaded)}
              max={parseSize(progress.total)}
              hasValueLabel
              formatValueLabel={() => {
                const parts = [`${progress.downloaded} / ${progress.total}`];
                if (progress.speed) parts.push(progress.speed);
                if (progress.eta) parts.push(`${progress.eta} remaining`);
                return parts.join('  ·  ');
              }}
            />
            {progress.filesTotal > 1 && (
              <ProgressBar
                label="Files"
                value={progress.filesDone}
                max={progress.filesTotal}
                hasValueLabel
                formatValueLabel={(v, m) => `${v} / ${m}`}
              />
            )}
          </VStack>
        )}
        <CodeBlock
          code={term?.lines.join('\n') || ' '}
          language="plaintext"
          hasCopyButton={false}
          isWrapped
          width="100%"
          maxHeight={384}
        />
        <HStack gap={2} hAlign="end">
          <Button
            label={running ? 'Cancel' : 'Close'}
            variant={running ? 'destructive' : 'secondary'}
            onClick={onClose}
          />
        </HStack>
      </VStack>
    </Dialog>
  );
}
