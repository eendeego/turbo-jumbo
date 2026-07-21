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
} from '@/lib/audit/audit';
import {describeExitCode} from '@/lib/hf/download-output';
import {repoFileSizes, resolveHfFileByPath} from '@/lib/hf/hf-infer';
import {repoIdFromModelUrl} from '@/lib/models/model-name';
import {
  clearMissingFlag,
  modelDirForRepo,
  removeFileMeta,
} from '@/lib/models/model-sidecar';

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
): Promise<{failures: string[]}> {
  const localBase = localModelsDir!;
  // Files that did not end up safely on disk (missing, or present but failing
  // verification). The caller uses this to refuse the cold-storage transfer.
  const failures: string[] = [];
  enqueue('\nRecording sources...\n');
  for (const fp of filePaths) {
    if (signal.aborted) return {failures};
    const relPath = path.join(repoId, fp);
    const hf = await resolveHfFileByPath(repoId, branch, fp);
    if (!hf) {
      // No HF source (a small non-LFS file): can't verify it, but if it's on
      // disk clear any `missing` flag a prior audit left so the model isn't
      // still reported incomplete. If it isn't on disk, the download failed.
      let size = -1;
      try {
        size = (await fsp.stat(path.join(localBase, relPath))).size;
      } catch {
        /* missing: handled below */
      }
      if (size < 0) {
        failures.push(fp);
        enqueue(`  ${fp}: missing — not written to disk\n`);
        continue;
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
    // Only a verified-present file (or one we can't verify but is on disk) is
    // safe to carry onward; anything else means the download didn't land.
    if (result.status !== 'pass' && result.status !== 'unverifiable') {
      failures.push(fp);
    }
  }
  return {failures};
}

// Binary units (÷1024), no space — the compact form the progress line uses.
// parseSize (lib/hf/download-output) decodes these back for the progress bar.
function fmtBytes(b: number): string {
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(1)}TiB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)}GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)}MiB`;
  return `${(b / 1024).toFixed(1)}KiB`;
}

function fmtTime(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Bytes-on-disk under `dir`, summed recursively, tolerant of files vanishing
// mid-walk (hf moves completed blobs out of its `.cache` staging area). Missing
// directory → 0. Used to gauge download progress, since hf prints none itself.
async function dirBytes(dir: string): Promise<number> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, {withFileTypes: true});
  } catch {
    return 0;
  }
  let total = 0;
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) total += await dirBytes(full);
      else if (ent.isFile()) total += (await fsp.stat(full)).size;
    } catch {
      /* file moved/removed between readdir and stat */
    }
  }
  return total;
}

// How many of the expected files are already on disk at their full size — the
// file-completion count for the progress bar. hf downloads to an incomplete temp
// path and moves the file into place only when it finishes, so a file present at
// its final path with its expected size is done. Needs the resolved sizes; files
// whose size is unknown can't be judged complete and are skipped.
async function completeFileCount(
  localDir: string,
  filePaths: string[],
  sizes: Map<string, number>,
): Promise<number> {
  let done = 0;
  for (const fp of filePaths) {
    const expected = sizes.get(fp);
    if (!expected || expected <= 0) continue;
    try {
      if ((await fsp.stat(path.join(localDir, fp))).size >= expected) done++;
    } catch {
      /* not on disk yet */
    }
  }
  return done;
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

/**
 * Run an `hf download` on this machine and stream its terminal output. Shared by
 * the `/api/v1/hf-download` route and the peer download proxy's local branch.
 * Validates the request body (returning a 400 Response on bad input) before
 * spawning. `signal` aborts the underlying process (SIGTERM) when the client
 * disconnects.
 */
export function streamHfDownload(body: unknown, signal: AbortSignal): Response {
  const {repoId, branch, filePaths, sendToCold, deleteAfterTransfer} = (body ??
    {}) as {
    repoId?: unknown;
    branch?: unknown;
    filePaths?: unknown;
    sendToCold?: unknown;
    deleteAfterTransfer?: unknown;
  };

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
  const localDir = path.join(localModelsDir!, repoId);
  // Storage-root-relative paths of the downloaded files, used for the sidecar
  // pass and the cold-storage transfer.
  const relPaths = (filePaths as string[]).map((fp) => path.join(repoId, fp));

  // Spawn hf directly with an argv array (no shell, no quoting) and force
  // `--json`: hf then prints a single `{"path": …}` on stdout on success, its
  // error text on stderr on failure, and nothing else — no progress bars or
  // chatter to scrape. Progress is synthesized below from bytes-on-disk.
  const hfArgs = ['download', repoId];
  for (const fp of filePaths as string[]) hfArgs.push('--include', fp);
  hfArgs.push('--local-dir', localDir, '--revision', branch, '--json');
  const numFiles = (filePaths as string[]).length;

  const encode = (s: string) => new TextEncoder().encode(s);

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (s: string) => controller.enqueue(encode(s));

      // The spawn inherits the server's environment: transfer acceleration
      // (HF_XET_HIGH_PERFORMANCE) and HF_TOKEN come from there (.envrc in
      // dev, ENV in the Dockerfile) rather than app code — forcing the
      // deprecated HF_HUB_ENABLE_HF_TRANSFER here made every download warn.
      const proc = spawn('hf', hfArgs);

      // hf --json prints no progress while downloading, so synthesize it: size
      // the bar from the repo's file sizes, then poll bytes-on-disk and emit a
      // `Downloading: NN% …` line (parsed by parseProgress) each tick — with a
      // `(done/total files)` suffix for a multi-file download, counting the files
      // already present at full size. Best-effort — if the repo can't be sized
      // (offline/rate-limited) we emit nothing and the client falls back to an
      // indeterminate bar.
      const t0 = Date.now();
      let totalBytes = 0;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      const stopPoll = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
      };
      const filesSuffix = (done: number) =>
        numFiles > 1 ? `  (${done}/${numFiles} files)` : '';
      void (async () => {
        const sizes = await repoFileSizes(repoId, branch);
        if (!sizes || signal.aborted) return;
        totalBytes = (filePaths as string[]).reduce(
          (sum, fp) => sum + (sizes.get(fp) ?? 0),
          0,
        );
        if (totalBytes <= 0) return;
        let lastDone = 0;
        let lastT = t0;
        pollTimer = setInterval(() => {
          void Promise.all([
            dirBytes(localDir),
            completeFileCount(localDir, filePaths as string[], sizes),
          ]).then(([raw, filesDone]) => {
            // The walk is async; if the run ended (stopPoll cleared the timer)
            // while it was in flight, the controller may be closed — don't
            // enqueue onto it.
            if (pollTimer === null) return;
            const done = Math.min(raw, totalBytes);
            const now = Date.now();
            const dt = (now - lastT) / 1000;
            const speed = dt > 0 ? (done - lastDone) / dt : 0;
            lastDone = done;
            lastT = now;
            const pct = Math.min(99, Math.floor((done / totalBytes) * 100));
            const eta = speed > 0 ? (totalBytes - done) / speed : 0;
            enqueue(
              `\rDownloading: ${pct}% ${fmtBytes(done)}/${fmtBytes(totalBytes)}` +
                ` [${fmtTime((now - t0) / 1000)}<${fmtTime(eta)}, ${fmtBytes(speed)}/s]` +
                filesSuffix(filesDone),
            );
          });
        }, 1000);
      })();

      signal.addEventListener('abort', () => {
        stopPoll();
        proc.kill('SIGTERM');
      });

      // stdout carries only hf's `--json` result — buffer it (handled on close);
      // it is a machine record, not something to show in the run log. stderr
      // carries hf's errors/warnings, forwarded verbatim into the log where
      // parseNotices lifts them into the dialog's notices panel.
      let stdoutBuf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        const text = stripAnsi(chunk.toString());
        if (text) enqueue(text);
      });

      proc.on('error', (err) => {
        stopPoll();
        enqueue(`\nError: ${err.message}\n`);
        controller.close();
      });

      proc.on('close', async (code, sig) => {
        stopPoll();
        // hf's stdout should be exactly its `{"path": …}` result — the wrapper
        // already knows where files land, so it's consumed, not shown. Anything
        // else (unexpected non-JSON output) is surfaced so it isn't lost.
        const out = stdoutBuf.trim();
        if (out && !(out.startsWith('{') && out.endsWith('}')))
          enqueue(`\n${out}\n`);
        // Carry the bar to 100% — the poll caps at 99% and hf's silence means
        // nothing else would.
        if (code === 0 && totalBytes > 0) {
          const tb = fmtBytes(totalBytes);
          enqueue(
            `\rDownload complete: 100% ${tb}/${tb} [${fmtTime((Date.now() - t0) / 1000)}]${filesSuffix(numFiles)}\n`,
          );
        }
        enqueue(`\nProcess exited with code ${code}\n`);
        try {
          if (code !== 0) {
            const desc =
              code === null
                ? `hf was killed by ${sig ?? 'a signal'}`
                : `hf exited with code ${describeExitCode(code)}`;
            enqueue(`\nError: download failed (${desc}).\n`);
            return;
          }
          // Even on a 0 exit, verify the files actually landed and pass audit —
          // some failures (and the historical exit-code masking) can slip
          // through. A failed verification must not reach cold storage.
          const {failures} = await recordSources(
            repoId,
            branch,
            filePaths as string[],
            signal,
            enqueue,
          );
          if (failures.length > 0) {
            enqueue(
              `\nError: download failed — ${failures.length} file(s) did not download correctly: ${failures.join(', ')}.\n` +
                `Skipping cold storage.\n`,
            );
            return;
          }
          if (sendToCold && coldStorageDir) {
            await moveToColdstorage(relPaths, !!deleteAfterTransfer, enqueue);
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
