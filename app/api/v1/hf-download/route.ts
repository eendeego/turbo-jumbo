import {spawn} from 'child_process';
import {localModelsDir} from '@/lib/config';

// Matches CSI sequences (\x1b[...X), OSC sequences (\x1b]...\x07), and other 2-char escapes
const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[^[\]])/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// repoId must be owner/repo with only safe characters
const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// folder is a single path segment (no slashes)
const FOLDER_RE = /^[A-Za-z0-9_. -]+$/;

export async function POST(req: Request) {
  if (!localModelsDir) {
    return new Response('No local peer configured', {status: 400});
  }

  const {repoId, folder} = await req.json();

  if (!repoId || typeof repoId !== 'string' || !REPO_ID_RE.test(repoId)) {
    return new Response('Invalid repoId', {status: 400});
  }
  if (
    folder !== null &&
    (typeof folder !== 'string' || !FOLDER_RE.test(folder))
  ) {
    return new Response('Invalid folder', {status: 400});
  }

  const include = folder ? `${folder}/*` : '*.gguf';

  // Run inside `script` to allocate a PTY so that hf/tqdm outputs live progress bars
  const cmd = [
    'hf',
    'download',
    repoId,
    '--include',
    include,
    '--local-dir',
    localModelsDir,
  ].join(' ');

  const stream = new ReadableStream({
    start(controller) {
      const proc = spawn('script', ['-q', '-c', cmd, '/dev/null'], {
        env: {...process.env, HF_HUB_ENABLE_HF_TRANSFER: '1'},
      });

      req.signal.addEventListener('abort', () => proc.kill('SIGTERM'));

      const encode = (s: string) => new TextEncoder().encode(s);

      const onData = (chunk: Buffer) => {
        const text = stripAnsi(chunk.toString());
        if (text) controller.enqueue(encode(text));
      };

      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('error', (err) => {
        controller.enqueue(encode(`\nError: ${err.message}\n`));
        controller.close();
      });

      proc.on('close', (code) => {
        controller.enqueue(encode(`\nProcess exited with code ${code}\n`));
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {'Content-Type': 'text/plain; charset=utf-8'},
  });
}
