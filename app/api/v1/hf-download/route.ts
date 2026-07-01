import {spawn} from 'child_process';
import {promises as fsp} from 'fs';
import path from 'path';
import {localModelsDir, coldStorageDir} from '@/lib/config';
import {
  auditFile,
  copyFileWithMeta,
  metaPath,
  readMetaResolved,
  updateMetaResolved,
} from '@/lib/audit';
import {resolveHfFileByPath} from '@/lib/hf-infer';
import {isObject, readJsonBody} from '@/lib/request';
import {repoIdFromModelUrl} from '@/lib/model-name';
import {
  clearMissingFlag,
  modelDirForRepo,
  removeFileMeta,
} from '@/lib/model-sidecar';
import {HF_HUB_ENABLE_HF_TRANSFER} from '@/lib/hf';

const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[^[\]])/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
const FILE_PATH_RE = /^[A-Za-z0-9_. /-]+$/;

// repoId/filePath become filesystem paths below (the download lands at
// <base>/<repoId>/<filePath>), so a `..` segment — which the patterns above
// otherwise permit — must be rejected to keep the write inside the storage root.
function hasUnsafeSegment(p: string): boolean {
  return p.split('/').some((seg) => seg === '..');
}

/**
 * Record the HuggingFace source for each freshly-downloaded file: resolve its
 * size/checksum from the repo, then run the normal audit (which hashes the file
 * locally and writes the `.tjmeta.json` sidecar) so the model is verifiable —
 * and, being placed at <repoId>/<filePath>, passes — without a manual step.
 */
async function recordSources(
  repoId: string,
  branch: string,
  filePaths: string[],
  signal: AbortSignal,
  enqueue: (s: string) => void,
): Promise<void> {
  const localBase = localModelsDir!;
  enqueue('\nRecording sources...\n');
  for (const fp of filePaths) {
    if (signal.aborted) return;
    const relPath = path.join(repoId, fp);
    const hf = await resolveHfFileByPath(repoId, branch, fp);
    if (!hf) {
      // No HF source (a small non-LFS file): can't verify it, but it's now on
      // disk — clear any `missing` flag a prior audit left so the model isn't
      // still reported incomplete.
      let size = 0;
      try {
        size = (await fsp.stat(path.join(localBase, relPath))).size;
      } catch {
        /* unreadable: clear with size 0, a later audit re-measures */
      }
      const cleared = await clearMissingFlag(localBase, repoId, fp, size);
      enqueue(
        `  ${fp}: ${cleared ? 'present — source unverifiable' : 'could not resolve source — left unverified'}\n`,
      );
      continue;
    }
    const result = await auditFile(
      localBase,
      relPath,
      '',
      path.basename(fp),
      signal,
      hf,
    );
    enqueue(`  ${fp}: ${result.status}\n`);
  }
}

function fmtBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)}TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)}GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)}MB`;
  return `${(b / 1e3).toFixed(1)}KB`;
}

async function moveToColdstorage(
  relPaths: string[],
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
  for (const rp of relPaths) {
    const size = (await fsp.stat(path.join(localBase, rp))).size;
    sizes.set(rp, size);
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

  // Rename a `.tjmeta.json` sidecar alongside its file; absence is fine.
  const renameSidecar = async (src: string, dst: string) => {
    try {
      await fsp.rename(metaPath(src), metaPath(dst));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  };

  const toDelete: string[] = [];

  // Carry the file's provenance entry into the cold-storage model sidecar, and
  // drop it from the local one when the local copy is being removed.
  const transferMeta = async (rp: string, removeLocal: boolean) => {
    const meta = await readMetaResolved(localBase, rp);
    if (!meta) return;
    const repoId = repoIdFromModelUrl(meta.modelUrl);
    if (!repoId) return;
    await updateMetaResolved(coldBase, rp, repoId, meta);
    if (removeLocal) {
      const loc = modelDirForRepo(rp, repoId);
      if (loc) await removeFileMeta(localBase, loc.dir, loc.key);
    }
  };

  for (const rp of relPaths) {
    const src = path.join(localBase, rp);
    const dst = path.join(coldBase, rp);

    if (deleteAfterTransfer) {
      try {
        await fsp.mkdir(path.dirname(dst), {recursive: true});
        await fsp.rename(src, dst);
        await renameSidecar(src, dst);
        await transferMeta(rp, true);
        onBytes(sizes.get(rp) ?? 0); // account for this file in progress
        continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // Cross-filesystem: copy then schedule delete
      }
    }

    await copyFileWithMeta(src, dst, onBytes);
    await transferMeta(rp, deleteAfterTransfer);
    if (deleteAfterTransfer) {
      toDelete.push(src, metaPath(src));
    }
  }

  enqueue('\n');

  if (toDelete.length > 0) {
    enqueue('Cleaning up local copy...\n');
    // force: a sidecar in the list may not exist for every file.
    for (const src of toDelete) await fsp.rm(src, {force: true});
  }

  enqueue('Done.\n');
}

export async function POST(req: Request) {
  if (!localModelsDir) {
    return new Response('No local peer configured', {status: 400});
  }

  const body = await readJsonBody<{
    repoId?: unknown;
    branch?: unknown;
    filePaths?: unknown;
    sendToCold?: unknown;
    deleteAfterTransfer?: unknown;
  }>(req, isObject);
  if (body instanceof Response) return body;
  const {repoId, branch, filePaths, sendToCold, deleteAfterTransfer} = body;

  if (
    !repoId ||
    typeof repoId !== 'string' ||
    !REPO_ID_RE.test(repoId) ||
    hasUnsafeSegment(repoId)
  )
    return new Response('Invalid repoId', {status: 400});
  if (!branch || typeof branch !== 'string' || !BRANCH_RE.test(branch))
    return new Response('Invalid branch', {status: 400});
  if (
    !Array.isArray(filePaths) ||
    filePaths.length === 0 ||
    filePaths.some(
      (fp: unknown) =>
        typeof fp !== 'string' ||
        !FILE_PATH_RE.test(fp) ||
        hasUnsafeSegment(fp),
    )
  )
    return new Response('Invalid filePaths', {status: 400});

  // Download into <base>/<repoId> so files land at <repoId>/<filePath> — the
  // layout the audit expects — making them correctly placed and verifiable.
  const localDir = path.join(localModelsDir, repoId);
  // Storage-root-relative paths of the downloaded files, used for the sidecar
  // pass and the cold-storage transfer.
  const relPaths = (filePaths as string[]).map((fp) => path.join(repoId, fp));

  const includes = (filePaths as string[])
    .map((fp) => `--include "${fp}"`)
    .join(' ');
  const cmd = [
    'hf',
    'download',
    repoId,
    includes,
    '--local-dir',
    localDir,
    '--revision',
    branch,
  ].join(' ');

  const encode = (s: string) => new TextEncoder().encode(s);

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (s: string) => controller.enqueue(encode(s));

      const proc = spawn('script', ['-q', '-c', cmd, '/dev/null'], {
        env: HF_HUB_ENABLE_HF_TRANSFER
          ? {...process.env, HF_HUB_ENABLE_HF_TRANSFER: '1'}
          : process.env,
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
          if (code === 0) {
            await recordSources(
              repoId,
              branch,
              filePaths as string[],
              req.signal,
              enqueue,
            );
            if (sendToCold && coldStorageDir) {
              await moveToColdstorage(relPaths, !!deleteAfterTransfer, enqueue);
            }
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
