/**
 * Parsing for the streamed `hf download` log (see `/api/v1/hf-download`). The
 * log interleaves three kinds of lines: download/transfer **progress**, our own
 * **wrapper status** (recording sources, cold-storage, `Done.`), and hf's
 * **chatter** (version hints, deprecation `FutureWarning`s) plus any errors.
 * `parseProgress` drives the progress bars; `parseNotices` surfaces the chatter
 * and errors into the dialog's notices panel.
 */

export type DownloadProgress = {
  percent: number;
  downloaded: string;
  total: string;
  speed: string | null;
  eta: string | null;
  filesDone: number;
  filesTotal: number;
};

export type NoticeSeverity = 'warning' | 'error';
export type Notice = {text: string; severity: NoticeSeverity};

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

export function parseSize(s: string): number {
  const m = s.match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return 0;
  return parseFloat(m[1]) * (SIZE_UNITS[m[2].toUpperCase()] ?? 1);
}

export function parseProgress(lines: string[]): DownloadProgress | null {
  let percent = 0;
  let downloaded = '';
  let total = '';
  let speed: string | null = null;
  let eta: string | null = null;
  let filesDone = 0;
  let filesTotal = 0;
  let hasDownload = false;

  for (const line of lines) {
    // "Downloading ...:   5% 523M/9.97G [00:12<04:39, 33.8MB/s]" and the final
    // "Download complete: 100% 9.97G/9.97G [..]" line. hf's "Downloading" bar can
    // stop emitting before 100%, so the "Download complete:" line is what carries
    // the bar to 100% in that case.
    const dl = line.match(
      /Download(?:ing[^:]*|\s+complete):\s+(\d+)%\s+([\d.]+\s*\S+)\/([\d.]+\s*\S+)\s+\[([^\]]*)\]/,
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

// hf's download/fetch/complete progress lines, the resulting "  path: …" line,
// and the cold-storage `[███░░] NN%` bar. These drive the bars, never notices.
function isProgressLine(line: string): boolean {
  const t = line.trimStart();
  return (
    /^Downloading\b/.test(t) ||
    /^Fetching\s+\d+\s+files?:/.test(t) ||
    /^Download complete:/.test(t) ||
    /^path:\s/.test(t) ||
    /^\[[█░]+\]/.test(t)
  );
}

// Status lines that frame the download, not real notices: the downloader's
// per-repo header (`=== repo (1/1) ===`), the exit notice, the source-recording
// header and its indented per-file results, the cold-storage steps, and the
// closing "Done.". Kept in the full log, not the notices panel. Any indented
// continuation is treated as one of the per-file results — hf's chatter and
// errors are flush-left.
function isWrapperLine(line: string): boolean {
  if (/^\s/.test(line)) return true;
  return (
    /^=== .+ ===\s*$/.test(line) ||
    /^Process exited with code/.test(line) ||
    /^Recording sources/.test(line) ||
    /^(Moving|Copying) to cold storage/.test(line) ||
    /^Cleaning up local copy/.test(line) ||
    /^Done\.?$/.test(line)
  );
}

export function parseNotices(lines: string[]): Notice[] {
  const notices: Notice[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (isProgressLine(line) || isWrapperLine(line)) continue;
    const severity: NoticeSeverity = /error|traceback/i.test(line)
      ? 'error'
      : 'warning';
    notices.push({text: line, severity});
  }
  return notices;
}
