import {test, expect} from 'bun:test';
import {parseProgress, parseNotices} from '@/lib/download-output';

// The download log as it arrives: progress lines, an hf version hint, and our
// own wrapper status, interleaved like a real run.
const versionHintRun = [
  'Hint: A new version of huggingface_hub (1.19.0) is available! You are using version 1.18.0.',
  'To update, run: hf update',
  'Downloading (incomplete total...): 0.00B [00:00, ?B/s]',
  'Downloading (incomplete total...): 100% 899M/899M [00:10<00:00, 132MB/s] ',
  'Fetching 1 files: 100% 1/1 [00:10<00:00, 10.07s/it]',
  'Download complete: 100% 899M/899M [00:10<00:00, 132MB/s]                ✓ Downloaded',
  '  path: /mnt/models/unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
  'Download complete: 100% 899M/899M [00:10<00:00, 89.1MB/s]',
  '',
  'Process exited with code 0',
  '',
  'Recording sources...',
  '  mmproj-F16.gguf: pass',
];

const futureWarningRun = [
  '/home/user/.hf-cli/venv/lib/python3.14/site-packages/huggingface_hub/constants.py:294:',
  "FutureWarning: The `HF_HUB_ENABLE_HF_TRANSFER` environment variable is deprecated as 'hf_transfer' is not used anymore.",
  'Please use `HF_XET_HIGH_PERFORMANCE` instead to enable high performance transfer with Xet. Visit https://huggingface.co/docs for more details.',
  'Downloading (incomplete total...): 100% 899M/899M [00:10<00:00, 132MB/s] ',
  'Fetching 1 files: 100% 1/1 [00:10<00:00, 10.07s/it]',
  'Done.',
];

test('parseNotices surfaces the version-update hint, excluding progress and wrapper status', () => {
  const notices = parseNotices(versionHintRun);
  expect(notices).toEqual([
    {
      text: 'Hint: A new version of huggingface_hub (1.19.0) is available! You are using version 1.18.0.',
      severity: 'warning',
    },
    {text: 'To update, run: hf update', severity: 'warning'},
  ]);
});

test('parseNotices surfaces the FutureWarning block as warnings', () => {
  const notices = parseNotices(futureWarningRun);
  expect(notices.map((n) => n.severity)).toEqual([
    'warning',
    'warning',
    'warning',
  ]);
  expect(notices[1].text).toContain('FutureWarning:');
  expect(notices[2].text).toContain('Please use');
});

test('parseNotices flags error lines with error severity', () => {
  const notices = parseNotices([
    'Downloading (incomplete total...): 100% 899M/899M [00:10<00:00, 132MB/s]',
    'Error: 401 Client Error. Repository not found or gated.',
  ]);
  expect(notices).toEqual([
    {
      text: 'Error: 401 Client Error. Repository not found or gated.',
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

test('parseNotices excludes hf\'s standalone "✓ Downloaded" success line', () => {
  const notices = parseNotices([
    'Fetching 2 files: 100% 2/2 [00:21<00:00, 10.7s/it]',
    '✓ Downloaded',
    '  path: /mnt/models/turbo-jumbo/ggml-org/gemma-3-4b-it-GGUF',
    'Process exited with code 0',
  ]);
  expect(notices).toEqual([]);
});

test('parseNotices ignores the per-repo download header', () => {
  const notices = parseNotices([
    '=== mikkoph/kokoro-onnx  (1/1) ===',
    'Downloading (incomplete total...): 100% 28.2M/28.2M [00:01<00:00, 22.3MB/s]',
    'Fetching 5 files: 100% 5/5 [00:01<00:00,  3.40it/s]',
    'Process exited with code 0',
    'Recording sources...',
    '  index.json: could not resolve source — left unverified',
  ]);
  expect(notices).toEqual([]);
});

// A real run where hf's transfer bar stopped emitting at 90% and completion was
// only signaled by the "Download complete:" lines — the "Downloading" bar never
// reached 100%.
const stalledBarRun = [
  'Hint: A new version of huggingface_hub (1.21.0) is available! You are using version 1.20.1.',
  'To update, run: hf update',
  'Downloading (incomplete total...): 0.00B [00:00, ?B/s]',
  'Downloading (incomplete total...):  90% 2.24G/2.49G [00:21<00:01, 199MB/s] ',
  'Fetching 1 files: 100% 1/1 [00:21<00:00, 21.38s/it]',
  'Download complete: 100% 2.49G/2.49G [00:21<00:00, 199MB/s]                ✓ Downloaded',
  '  path: /mnt/models/turbo-jumbo/unsloth/Phi-4-mini-instruct-GGUF',
  'Download complete: 100% 2.49G/2.49G [00:21<00:00, 116MB/s]',
  '',
  'Process exited with code 0',
  '',
  'Recording sources...',
  '  Phi-4-mini-instruct-Q4_K_M.gguf: pass',
];

test('parseProgress reaches 100% from the "Download complete" line when the download bar stalled below 100%', () => {
  const p = parseProgress(stalledBarRun);
  expect(p).not.toBeNull();
  expect(p!.percent).toBe(100);
  expect(p!.downloaded).toBe('2.49G');
  expect(p!.total).toBe('2.49G');
  expect(p!.filesDone).toBe(1);
  expect(p!.filesTotal).toBe(1);
});

test('parseProgress still parses the download and files bars', () => {
  const p = parseProgress(versionHintRun);
  expect(p).not.toBeNull();
  expect(p!.percent).toBe(100);
  expect(p!.downloaded).toBe('899M');
  expect(p!.total).toBe('899M');
  expect(p!.filesDone).toBe(1);
  expect(p!.filesTotal).toBe(1);
});
