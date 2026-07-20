import {test, expect} from 'bun:test';
import {
  parseProgress,
  parseNotices,
  hasDownloadFailure,
  describeExitCode,
} from '@/lib/hf/download-output';

// A successful run as the client sees it under `hf --json`: the server's own
// synthesized `Downloading:`/`Download complete:` progress (hf itself prints
// none in json mode), then the wrapper's exit and source-recording status. hf's
// `{"path": …}` result line is consumed server-side and never reaches this log.
const successRun = [
  '=== Qwen/Qwen3-0.6B-GGUF  (1/1) ===',
  'Download complete: 100% 639.4MB/639.4MB [00:11]',
  '',
  'Process exited with code 0',
  '',
  'Recording sources...',
  '  Qwen3-0.6B-Q4_K_M.gguf: pass',
];

// A failed run: hf writes its error block to stderr (forwarded verbatim), then
// the wrapper appends its own flush-left failure line.
const errorRun = [
  '=== does-not-exist/nope-xyz  (1/1) ===',
  "Error: Model 'does-not-exist/nope-xyz' not found.",
  'If the repo is private, make sure you are authenticated and your token has the required permissions.',
  'If the repo does not exist, create it with: hf repos create does-not-exist/nope-xyz',
  '',
  'Process exited with code 1',
  '',
  'Error: download failed (hf exited with code 1).',
];

test('parseProgress reads the synthesized mid-download line', () => {
  const p = parseProgress([
    'Downloading: 45% 287.7MB/639.4MB [00:05<00:06, 57.5MB/s]',
  ]);
  expect(p).not.toBeNull();
  expect(p!.percent).toBe(45);
  expect(p!.downloaded).toBe('287.7MB');
  expect(p!.total).toBe('639.4MB');
  expect(p!.speed).toBe('57.5MB/s');
  expect(p!.eta).toBe('00:06');
  // No file-count suffix on a single-file download.
  expect(p!.filesDone).toBe(0);
  expect(p!.filesTotal).toBe(0);
});

test('parseProgress reads the synthesized per-file count on a multi-file download', () => {
  const p = parseProgress([
    'Downloading: 40% 1.0GB/2.5GB [00:05<00:07, 200MB/s]  (2/5 files)',
  ]);
  expect(p).not.toBeNull();
  expect(p!.percent).toBe(40);
  expect(p!.downloaded).toBe('1.0GB');
  expect(p!.total).toBe('2.5GB');
  expect(p!.filesDone).toBe(2);
  expect(p!.filesTotal).toBe(5);
});

test('parseProgress reaches 100% from the synthesized completion line', () => {
  const p = parseProgress(successRun);
  expect(p).not.toBeNull();
  expect(p!.percent).toBe(100);
  expect(p!.downloaded).toBe('639.4MB');
  expect(p!.total).toBe('639.4MB');
});

test('parseProgress carries the file count to complete on the completion line', () => {
  const p = parseProgress([
    'Download complete: 100% 2.5GB/2.5GB [00:12]  (5/5 files)',
  ]);
  expect(p).not.toBeNull();
  expect(p!.percent).toBe(100);
  expect(p!.filesDone).toBe(5);
  expect(p!.filesTotal).toBe(5);
});

test('parseProgress returns null when there is no download line yet', () => {
  expect(
    parseProgress(['=== repo (1/1) ===', 'Recording sources...']),
  ).toBeNull();
});

test('parseNotices surfaces nothing for a clean successful run', () => {
  expect(parseNotices(successRun)).toEqual([]);
});

test("parseNotices surfaces hf's stderr error block, flagging the Error line", () => {
  const notices = parseNotices(errorRun);
  expect(notices).toEqual([
    {
      text: "Error: Model 'does-not-exist/nope-xyz' not found.",
      severity: 'error',
    },
    {
      text: 'If the repo is private, make sure you are authenticated and your token has the required permissions.',
      severity: 'warning',
    },
    {
      text: 'If the repo does not exist, create it with: hf repos create does-not-exist/nope-xyz',
      severity: 'warning',
    },
    {
      text: 'Error: download failed (hf exited with code 1).',
      severity: 'error',
    },
  ]);
});

test('parseNotices excludes cold-storage progress and wrapper status', () => {
  const notices = parseNotices([
    'Moving to cold storage...',
    '[████████████████████] 100%  899.0MB / 899.0MB',
    'Cleaning up local copy...',
    'Done.',
    '  config.json: pass',
  ]);
  expect(notices).toEqual([]);
});

test('parseNotices excludes the synthesized progress line, file suffix and all', () => {
  const notices = parseNotices([
    'Downloading: 40% 1.0GB/2.5GB [00:05<00:07, 200MB/s]  (2/5 files)',
    'Download complete: 100% 2.5GB/2.5GB [00:12]  (5/5 files)',
  ]);
  expect(notices).toEqual([]);
});

test('parseNotices ignores the per-repo download header', () => {
  const notices = parseNotices([
    '=== mikkoph/kokoro-onnx  (1/1) ===',
    'Download complete: 100% 28.2M/28.2M [00:01]',
    'Process exited with code 0',
    'Recording sources...',
    '  index.json: could not resolve source — left unverified',
  ]);
  expect(notices).toEqual([]);
});

// A run where hf was killed mid-transfer (e.g. the OOM killer): the wrapper
// emits the exit notice and the flush-left failure line.
const killedRun = [
  'Downloading: 32% 206.7MB/639.4MB [00:09<00:19, 22.1MB/s]',
  '',
  'Process exited with code 137',
  '',
  'Error: download failed (hf exited with code 137 — killed by signal 9 (SIGKILL), usually the out-of-memory killer).',
];

test('parseNotices surfaces the failure but not the plan-stop status line', () => {
  const lines = [
    ...killedRun,
    'Stopping: unsloth/gemma-4-mtp-GGUF failed — skipping the remaining 2 download(s) of this plan.',
  ];
  const notices = parseNotices(lines);
  expect(notices).toEqual([
    {
      text: 'Error: download failed (hf exited with code 137 — killed by signal 9 (SIGKILL), usually the out-of-memory killer).',
      severity: 'error',
    },
  ]);
});

test('hasDownloadFailure spots the wrapper failure line and ignores healthy runs', () => {
  expect(hasDownloadFailure(killedRun)).toBe(true);
  expect(hasDownloadFailure(successRun)).toBe(false);
  // The verification-failure variant counts too.
  expect(
    hasDownloadFailure([
      'Error: download failed — 1 file(s) did not download correctly: a.gguf.',
    ]),
  ).toBe(true);
  // hf's own chatter mentioning errors is not a wrapper failure line.
  expect(hasDownloadFailure(['Some error occurred upstream'])).toBe(false);
});

test('describeExitCode names signal deaths and leaves plain exits bare', () => {
  expect(describeExitCode(1)).toBe('1');
  expect(describeExitCode(2)).toBe('2');
  expect(describeExitCode(137)).toBe(
    '137 — killed by signal 9 (SIGKILL), usually the out-of-memory killer',
  );
  expect(describeExitCode(143)).toBe('143 — killed by signal 15 (SIGTERM)');
});
