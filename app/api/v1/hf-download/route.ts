import {spawn} from 'child_process';
import {createReadStream, createWriteStream, promises as fsp} from 'fs';
import path from 'path';
import {localModelsDir, coldStorageDir} from '@/lib/config';

// Matches CSI sequences (\x1b[...X), OSC sequences (\x1b]...\x07), and other 2-char escapes
const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[^[\]])/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// repoId must be owner/repo with only safe characters
const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// folder is a single path segment (no slashes)
const FOLDER_RE = /^[A-Za-z0-9_. -]+$/;

function fmtBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)}TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)}GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)}MB`;
  return `${(b / 1e3).toFixed(1)}KB`;
}

async function getDirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fsp.readdir(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory()
      ? await getDirSize(full)
      : (await fsp.stat(full)).size;
  }
  return total;
}

async function copyDir(
  src: string,
  dst: string,
  onBytes: (n: number) => void,
): Promise<void> {
  await fsp.mkdir(dst, {recursive: true});
  for (const entry of await fsp.readdir(src, {withFileTypes: true})) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d, onBytes);
    } else {
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(s);
        const ws = createWriteStream(d);
        rs.on('data', (chunk: Buffer | string) => onBytes(chunk.length));
        rs.once('error', reject);
        ws.once('error', reject);
        ws.once('finish', resolve);
        rs.pipe(ws);
      });
    }
  }
}

async function moveToColdstorage(
  folder: string,
  deleteAfterTransfer: boolean,
  enqueue: (s: string) => void,
): Promise<void> {
  const src = path.join(localModelsDir!, folder);
  const dst = path.join(coldStorageDir!, folder);

  // On the same filesystem a rename is instant — use it only when we're deleting anyway
  if (deleteAfterTransfer) {
    enqueue(`\nMoving to cold storage...\n`);
    try {
      await fsp.rename(src, dst);
      enqueue(`Done.\n`);
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      // Cross-filesystem: fall through to copy + delete
    }
  } else {
    enqueue(`\nCopying to cold storage...\n`);
  }

  const total = await getDirSize(src);
  let copied = 0;
  let lastPct = -1;

  const onBytes = (n: number) => {
    copied += n;
    const pct = total > 0 ? Math.round((copied / total) * 100) : 100;
    if (pct === lastPct) return;
    lastPct = pct;
    const filled = Math.round(pct / 5); // 20-char bar
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    enqueue(`\r[${bar}] ${pct}%  ${fmtBytes(copied)} / ${fmtBytes(total)}`);
  };

  await copyDir(src, dst, onBytes);
  enqueue('\n');

  if (deleteAfterTransfer) {
    enqueue(`Cleaning up local copy...\n`);
    await fsp.rm(src, {recursive: true});
  }

  enqueue(`Done.\n`);
}

export async function POST(req: Request) {
  if (!localModelsDir) {
    return new Response('No local peer configured', {status: 400});
  }

  const {repoId, folder, sendToCold, deleteAfterTransfer} = await req.json();

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

  const encode = (s: string) => new TextEncoder().encode(s);

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (s: string) => controller.enqueue(encode(s));

      const proc = spawn('script', ['-q', '-c', cmd, '/dev/null'], {
        env: {...process.env, HF_HUB_ENABLE_HF_TRANSFER: '1'},
      });

      req.signal.addEventListener('abort', () => proc.kill('SIGTERM'));

      const onData = (chunk: Buffer) => {
        const text = stripAnsi(chunk.toString());
        if (text) enqueue(text);
      };

      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);

      proc.on('error', (err) => {
        enqueue(`\nError: ${err.message}\n`);
        controller.close();
      });

      proc.on('close', async (code) => {
        enqueue(`\nProcess exited with code ${code}\n`);
        try {
          if (code === 0 && sendToCold && folder && coldStorageDir) {
            await moveToColdstorage(folder, !!deleteAfterTransfer, enqueue);
          }
        } catch (err: unknown) {
          enqueue(`\nError: ${(err as Error).message}\n`);
        } finally {
          controller.close();
        }
      });
    },
  });

  return new Response(stream, {
    headers: {'Content-Type': 'text/plain; charset=utf-8'},
  });
}
