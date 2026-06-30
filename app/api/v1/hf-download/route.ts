import {spawn} from 'child_process';
import {createReadStream, createWriteStream, promises as fsp} from 'fs';
import path from 'path';
import {localModelsDir, coldStorageDir} from '@/lib/config';

const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[^[\]])/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
const FILE_PATH_RE = /^[A-Za-z0-9_. /-]+$/;

function fmtBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)}TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)}GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)}MB`;
  return `${(b / 1e3).toFixed(1)}KB`;
}

async function copyFile(
  src: string,
  dst: string,
  onBytes: (n: number) => void,
): Promise<void> {
  await fsp.mkdir(path.dirname(dst), {recursive: true});
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(src);
    const ws = createWriteStream(dst);
    rs.on('data', (chunk: Buffer | string) => onBytes(chunk.length));
    rs.once('error', reject);
    ws.once('error', reject);
    ws.once('finish', resolve);
    rs.pipe(ws);
  });
}

async function moveToColdstorage(
  filePaths: string[],
  deleteAfterTransfer: boolean,
  enqueue: (s: string) => void,
): Promise<void> {
  const label = deleteAfterTransfer ? 'Moving' : 'Copying';
  enqueue(`\n${label} to cold storage...\n`);

  const localBase = localModelsDir!;
  const coldBase = coldStorageDir!;

  // Pre-compute sizes for the progress bar
  const sizes = new Map<string, number>();
  let total = 0;
  for (const fp of filePaths) {
    const size = (await fsp.stat(path.join(localBase, fp))).size;
    sizes.set(fp, size);
    total += size;
  }

  let done = 0;
  let lastPct = -1;
  const onBytes = (n: number) => {
    done += n;
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    if (pct === lastPct) return;
    lastPct = pct;
    const filled = Math.round(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    enqueue(`\r[${bar}] ${pct}%  ${fmtBytes(done)} / ${fmtBytes(total)}`);
  };

  const toDelete: string[] = [];

  for (const fp of filePaths) {
    const src = path.join(localBase, fp);
    const dst = path.join(coldBase, fp);

    if (deleteAfterTransfer) {
      try {
        await fsp.mkdir(path.dirname(dst), {recursive: true});
        await fsp.rename(src, dst);
        onBytes(sizes.get(fp) ?? 0); // account for this file in progress
        continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // Cross-filesystem: copy then schedule delete
      }
    }

    await copyFile(src, dst, onBytes);
    if (deleteAfterTransfer) toDelete.push(src);
  }

  enqueue('\n');

  if (toDelete.length > 0) {
    enqueue('Cleaning up local copy...\n');
    for (const src of toDelete) await fsp.rm(src);
  }

  enqueue('Done.\n');
}

export async function POST(req: Request) {
  if (!localModelsDir) {
    return new Response('No local peer configured', {status: 400});
  }

  const {repoId, branch, filePaths, sendToCold, deleteAfterTransfer} =
    await req.json();

  if (!repoId || typeof repoId !== 'string' || !REPO_ID_RE.test(repoId))
    return new Response('Invalid repoId', {status: 400});
  if (!branch || typeof branch !== 'string' || !BRANCH_RE.test(branch))
    return new Response('Invalid branch', {status: 400});
  if (
    !Array.isArray(filePaths) ||
    filePaths.length === 0 ||
    filePaths.some(
      (fp: unknown) => typeof fp !== 'string' || !FILE_PATH_RE.test(fp),
    )
  )
    return new Response('Invalid filePaths', {status: 400});

  const includes = (filePaths as string[])
    .map((fp) => `--include "${fp}"`)
    .join(' ');
  const cmd = [
    'hf',
    'download',
    repoId,
    includes,
    '--local-dir',
    localModelsDir,
    '--revision',
    branch,
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
          if (code === 0 && sendToCold && coldStorageDir) {
            await moveToColdstorage(
              filePaths as string[],
              !!deleteAfterTransfer,
              enqueue,
            );
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
