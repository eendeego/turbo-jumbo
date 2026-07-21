/**
 * Parsing for the streamed `hf download` log (see `/api/v1/hf-download`). Under
 * `hf --json` the CLI prints no progress and no chatter — its `{"path": …}`
 * result is consumed server-side — so the log holds just two kinds of lines:
 * the server's own synthesized transfer **progress** (both a byte bar and, for a
 * multi-file download, a `(done/total files)` count, computed by polling
 * bytes-on-disk) and **wrapper status** (recording sources, cold-storage,
 * `Done.`), plus, on failure, hf's error text forwarded from stderr.
 * `parseProgress` drives the progress bars; `parseNotices` lifts hf's
 * errors/warnings into the dialog's notices panel.
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

// The progress line is synthesized with binary units (fmtBytes), so those are
// what parseSize decodes; the decimal spellings are kept as a tolerant fallback.
const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KIB: 1024,
  KB: 1e3,
  K: 1e3,
  MIB: 1024 ** 2,
  MB: 1e6,
  M: 1e6,
  GIB: 1024 ** 3,
  GB: 1e9,
  G: 1e9,
  TIB: 1024 ** 4,
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
    // The server synthesizes progress by polling bytes-on-disk (hf --json emits
    // none): "Downloading: 5% 523M/9.97G [00:12<04:39, 33.8MB/s]" while running,
    // then a final "Download complete: 100% 9.97G/9.97G [00:13]" that carries the
    // bar to 100% — the poll caps at 99%, so completion comes from that line.
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

    // "…  (2/5 files)" — the file-completion count the server appends to the
    // progress line for a multi-file (sharded) download.
    const ft = line.match(/\((\d+)\/(\d+) files\)/);
    if (ft) {
      filesDone = parseInt(ft[1], 10);
      filesTotal = parseInt(ft[2], 10);
    }
  }

  if (!hasDownload) return null;
  return {percent, downloaded, total, speed, eta, filesDone, filesTotal};
}

// The server's synthesized transfer lines ("Downloading: …" / "Download
// complete: …", each optionally carrying a "(done/total files)" suffix) and the
// cold-storage `[███░░] NN%` bar. These report progress, never notices.
function isProgressLine(line: string): boolean {
  const t = line.trimStart();
  return (
    /^Downloading\b/.test(t) ||
    /^Download complete:/.test(t) ||
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
    /^Stopping: .+ failed — skipping/.test(line) ||
    /^Recording sources/.test(line) ||
    /^(Moving|Copying) to cold storage/.test(line) ||
    /^Cleaning up local copy/.test(line) ||
    /^Done\.?$/.test(line)
  );
}

/**
 * Whether the log contains the wrapper's flush-left failure line ("Error:
 * download failed …"), emitted on a nonzero hf exit or failed verification.
 * Used by the multi-repo runner to stop a plan when one job fails.
 */
export function hasDownloadFailure(lines: string[]): boolean {
  return lines.some((l) => /^Error: download failed/.test(l));
}

/**
 * Render an exit code for the failure line. Codes above 128 are signal deaths
 * (128 + signal number) — name the signal, and for SIGKILL point at the usual
 * culprit, since "code 137" alone reads as gibberish precisely when the box is
 * out of memory and the user most needs the hint.
 */
export function describeExitCode(code: number): string {
  if (code <= 128) return String(code);
  const sig = code - 128;
  const names: Record<number, string> = {
    6: 'SIGABRT',
    9: 'SIGKILL',
    15: 'SIGTERM',
  };
  const name = names[sig] ? ` (${names[sig]})` : '';
  const oomHint = sig === 9 ? ', usually the out-of-memory killer' : '';
  return `${code} — killed by signal ${sig}${name}${oomHint}`;
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
