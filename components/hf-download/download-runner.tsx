'use client';

import {useMemo, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Banner} from '@astryxdesign/core/Banner';
import {
  hasDownloadFailure,
  parseNotices,
  parseProgress,
  parseSize,
  type DownloadProgress,
} from '@/lib/hf/download-output';

// Padding for the pinned status region in the dialog header, matching
// LayoutContent's inset so the banners and progress bars align with the body.
const styles = stylex.create({
  status: {
    paddingInline: 'var(--spacing-4)',
    paddingBlock: 'var(--spacing-4)',
  },
});

export type TermState = {lines: string[]; col: number};

export type {DownloadProgress} from '@/lib/hf/download-output';

export type DownloadRequest = {
  repoId: string;
  branch: string;
  filePaths: string[];
  // The file set that makes a complete copy of this model, when the download
  // is deliberately file-scoped (a FastFlowLM registry pin). May be a
  // superset of filePaths (files already at the target are skipped).
  // Completeness checks then judge only these files.
  fileScope?: string[];
  sendToCold?: boolean;
  deleteAfterTransfer?: boolean;
};

/**
 * The `hf` command line the server runs for a download request, mirroring the
 * `/api/v1/hf-download` route (`--local-dir`, an explicit `--revision`; env
 * like HF_XET_HIGH_PERFORMANCE is inherited from the server's environment).
 * Shown so a user can copy and reproduce a run.
 */
export function buildHfCommand(req: DownloadRequest, localDir: string): string {
  const includes = req.filePaths.map((fp) => `--include "${fp}"`).join(' ');
  return `hf download ${req.repoId} ${includes} --local-dir ${localDir} --revision ${req.branch}`;
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

/**
 * Drives a streaming `/api/v1/hf-download` run: posts the request, parses the
 * terminal output into a redrawing buffer and structured progress, and exposes
 * cancel/reset. Reused by the HF download box and the audit "Redownload" action.
 * `displayPath` is the `--local-dir` surfaced back in the `command` string so
 * every caller's modal can disclose the `hf` command line; `downloadUrl` is the
 * endpoint each run POSTs to — the local route by default, or a peer proxy when
 * the download targets a remote machine.
 */
export function useDownloadRunner(
  displayPath: string,
  downloadUrl = '/api/v1/hf-download',
) {
  const [term, setTerm] = useState<TermState | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [running, setRunning] = useState(false);
  // The `hf` command line(s) for the active run — one per repo, joined by a
  // blank line for a multi-repo plan. Cleared on reset.
  const [command, setCommand] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Stream one request onto `initial`, redrawing the terminal and progress as
  // output arrives; returns the final buffer so a multi-repo run can continue
  // appending. Shared by `start` (one repo) and `startMany` (a plan).
  const runOne = async (
    req: DownloadRequest,
    abort: AbortController,
    initial: TermState,
  ): Promise<TermState> => {
    let state = initial;
    const res = await fetch(downloadUrl, {
      method: 'POST',
      signal: abort.signal,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(req),
    });

    if (!res.ok || !res.body) {
      state = applyChunk(state, `Error: ${res.statusText}\n`);
      setTerm({...state});
      return state;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      state = applyChunk(state, decoder.decode(value, {stream: true}));
      setTerm({...state});
      const p = parseProgress(state.lines);
      if (p) setProgress(p);
    }
    return state;
  };

  const start = async (req: DownloadRequest) => {
    if (running) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    setTerm({lines: [''], col: 0});
    setProgress(null);
    setCommand(buildHfCommand(req, displayPath));

    try {
      await runOne(req, abort, {lines: [''], col: 0});
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setTerm({lines: [`Error: ${String(e)}`], col: 0});
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  // Run several requests in sequence (one per repo), into a single terminal
  // with a header before each. `onJob` fires as each starts, for a progress
  // title. Stops early if cancelled. Used for omni collection downloads.
  const startMany = async (
    reqs: DownloadRequest[],
    onJob?: (index: number, req: DownloadRequest) => void,
  ) => {
    if (running || reqs.length === 0) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    let state: TermState = {lines: [''], col: 0};
    setTerm(state);
    setProgress(null);
    setCommand(reqs.map((r) => buildHfCommand(r, displayPath)).join('\n\n'));

    try {
      for (let i = 0; i < reqs.length; i++) {
        if (abort.signal.aborted) break;
        onJob?.(i, reqs[i]);
        state = applyChunk(
          state,
          `${i > 0 ? '\n' : ''}=== ${reqs[i].repoId}  (${i + 1}/${reqs.length}) ===\n`,
        );
        setTerm({...state});
        setProgress(null);
        const jobStart = state.lines.length - 1;
        state = await runOne(reqs[i], abort, state);
        // A failed job poisons the plan (a multi-repo model missing a piece
        // can't run) — stop instead of burying the error under the next repo.
        if (hasDownloadFailure(state.lines.slice(jobStart))) {
          const left = reqs.length - i - 1;
          if (left > 0) {
            state = applyChunk(
              state,
              `\nStopping: ${reqs[i].repoId} failed — skipping the remaining ${left} download(s) of this plan.\n`,
            );
            setTerm({...state});
          }
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        state = applyChunk(state, `\nError: ${String(e)}\n`);
        setTerm({...state});
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
    setCommand(null);
  };

  return {term, progress, running, command, start, startMany, cancel, reset};
}

/** Streaming progress + terminal output dialog for a download run. A single
 *  "Show details" disclosure reveals the `hf` command (when supplied) followed
 *  by the full raw output. */
export function DownloadModal({
  title = 'Downloading…',
  term,
  progress,
  running,
  command,
  hfTokenSet = true,
  onClose,
}: {
  title?: string;
  term: TermState | null;
  progress: DownloadProgress | null;
  running: boolean;
  command?: string;
  hfTokenSet?: boolean;
  onClose: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  // hf's hints/deprecation warnings and any errors, lifted out of the raw log
  // so they're always visible even while the full output stays collapsed.
  const notices = useMemo(() => (term ? parseNotices(term.lines) : []), [term]);

  const hasStatus =
    !hfTokenSet || notices.length > 0 || running || progress != null;

  // The status cluster (token/notice banners and the progress bars) lives in the
  // pinned header, not the scrolling body, so progress stays in view however far
  // the full output is scrolled. Only the collapsible details scroll; the footer
  // stays pinned too.
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      width="min(760px, 92vw)"
      maxHeight="85vh"
      purpose="form"
    >
      <Layout
        header={
          <>
            <DialogHeader title={title} hasDivider={!hasStatus} />
            {hasStatus && (
              <VStack gap={4} xstyle={styles.status}>
                {!hfTokenSet && (
                  <Banner
                    status="warning"
                    title="HF_TOKEN is not set — gated or private repositories may fail to download."
                  />
                )}
                {notices.length > 0 && (
                  <Banner
                    status={
                      notices.some((n) => n.severity === 'error')
                        ? 'error'
                        : 'warning'
                    }
                    title={notices[0].text}
                    defaultIsExpanded={notices.length > 1}
                  >
                    {notices.length > 1 && (
                      <VStack gap={1}>
                        {notices.slice(1).map((n, i) => (
                          <Text key={i} type="supporting">
                            {n.text}
                          </Text>
                        ))}
                      </VStack>
                    )}
                  </Banner>
                )}
                {running && !progress && (
                  <ProgressBar label="Downloading…" isIndeterminate />
                )}
                {progress && (
                  <VStack gap={2}>
                    <ProgressBar
                      label="Download"
                      value={parseSize(progress.downloaded)}
                      max={parseSize(progress.total)}
                      hasValueLabel
                      formatValueLabel={() => {
                        const parts = [
                          `${progress.downloaded} / ${progress.total}`,
                        ];
                        if (progress.speed) parts.push(progress.speed);
                        if (progress.eta)
                          parts.push(`${progress.eta} remaining`);
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
              </VStack>
            )}
          </>
        }
        content={
          <LayoutContent>
            <VStack gap={2}>
              <Button
                label={showDetails ? 'Hide details ▴' : 'Show details ▾'}
                variant="ghost"
                size="sm"
                onClick={() => setShowDetails((v) => !v)}
              />
              {showDetails && (
                <VStack gap={3}>
                  {command && (
                    <VStack gap={1}>
                      <Text type="supporting">Command</Text>
                      <CodeBlock
                        code={command}
                        language="bash"
                        isWrapped
                        width="100%"
                      />
                    </VStack>
                  )}
                  <VStack gap={1}>
                    <Text type="supporting">Full output</Text>
                    <CodeBlock
                      code={term?.lines.join('\n') || ' '}
                      language="plaintext"
                      hasCopyButton={false}
                      isWrapped
                      width="100%"
                      maxHeight={384}
                    />
                  </VStack>
                </VStack>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                label={running ? 'Cancel' : 'Close'}
                variant={running ? 'destructive' : 'secondary'}
                onClick={onClose}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
