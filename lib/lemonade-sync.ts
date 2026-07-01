import {promises as fsp} from 'fs';
import nodePath from 'path';
import {logger} from '@/lib/logger';
import {upsertFileMeta, type TjModelFile} from '@/lib/model-sidecar';

// Sync Lemonade's HuggingFace-cache models into Turbo Jumbo's flat mirror so a
// single copy on disk serves both. A file only in Lemonade is moved into
// `<tj>/<org>/<repo>/<repoPath>`; a file Turbo Jumbo already holds an identical
// copy of has its Lemonade duplicate deleted. Either way the Lemonade
// `models--<org>--<repo>/snapshots/<rev>/<repoPath>` entry becomes a symlink
// into Turbo Jumbo.

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface LemonadeRepo {
  repoId: string;
  rev: string; // snapshot revision (repo HEAD) — names the snapshots/<rev>/ dir
  dir: string; // absolute path to the models--<org>--<repo> directory
}

export type SyncFileStatus =
  | 'linked' // moved to Turbo Jumbo and replaced with a symlink
  | 'deduplicated' // an identical Turbo Jumbo copy existed — Lemonade dup deleted, symlinked
  | 'already-linked' // the Lemonade entry was already a symlink — left alone
  | 'skipped' // Turbo Jumbo holds a *different* file — left alone
  | 'error';

export interface SyncFileResult {
  repoPath: string;
  status: SyncFileStatus;
  message?: string;
}

export interface SyncModelResult {
  repoId: string;
  rev: string;
  files: SyncFileResult[];
}

/** Decode a `models--<org>--<repo>` directory name into its repo id, or null. */
function decodeRepoDir(dirName: string): string | null {
  if (!dirName.startsWith('models--')) return null;
  const repoId = dirName.slice('models--'.length).replaceAll('--', '/');
  return REPO_ID_RE.test(repoId) ? repoId : null;
}

/** The snapshot revision for a cache repo dir: `refs/main` when present, else
 *  the sole `snapshots/` entry. Null when it can't be resolved unambiguously. */
async function resolveRev(repoDir: string): Promise<string | null> {
  try {
    const ref = (
      await fsp.readFile(nodePath.join(repoDir, 'refs', 'main'), 'utf8')
    ).trim();
    if (ref) return ref;
  } catch {
    /* no refs/main — fall back to the snapshots dir */
  }
  try {
    const snaps = (
      await fsp.readdir(nodePath.join(repoDir, 'snapshots'), {
        withFileTypes: true,
      })
    ).filter((e) => e.isDirectory());
    if (snaps.length === 1) return snaps[0].name;
  } catch {
    /* no snapshots dir */
  }
  return null;
}

/** Every Lemonade cache repo under `lemonadeBase`, with its resolved revision.
 *  Dirs that aren't `models--…` or whose revision can't be resolved are skipped. */
export async function listLemonadeRepos(
  lemonadeBase: string,
): Promise<LemonadeRepo[]> {
  const base = nodePath.resolve(lemonadeBase);
  let entries;
  try {
    entries = await fsp.readdir(base, {withFileTypes: true});
  } catch {
    return [];
  }
  const out: LemonadeRepo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const repoId = decodeRepoDir(e.name);
    if (!repoId) continue;
    const dir = nodePath.join(base, e.name);
    const rev = await resolveRev(dir);
    if (!rev) continue;
    out.push({repoId, rev, dir});
  }
  return out;
}

// A real file (not a symlink) somewhere under `root`, with its path relative to
// `root`. Symlinks are returned too (so an already-synced entry is visible),
// flagged so the caller leaves them be. Directories are walked, not returned.
interface SnapshotEntry {
  repoPath: string;
  full: string;
  isSymlink: boolean;
}

async function walkSnapshot(root: string): Promise<SnapshotEntry[]> {
  const out: SnapshotEntry[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const e of entries) {
      const full = nodePath.join(dir, e.name);
      if (e.isSymbolicLink()) {
        out.push({
          repoPath: nodePath.relative(root, full),
          full,
          isSymlink: true,
        });
      } else if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        out.push({
          repoPath: nodePath.relative(root, full),
          full,
          isSymlink: false,
        });
      }
    }
  }
  await walk(root);
  return out;
}

/** Whether Turbo Jumbo already holds a copy of `repoId` (its flat dir exists and
 *  is non-empty) — such a model isn't "Lemonade-only" and is left untouched. */
async function tjHasModel(tjBase: string, repoId: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(nodePath.join(tjBase, repoId));
    return entries.length > 0;
  } catch {
    return false;
  }
}

/** Lemonade repos that don't yet exist in Turbo Jumbo — the sync candidates. */
export async function findLemonadeOnlyRepos(
  tjBase: string,
  lemonadeBase: string,
): Promise<LemonadeRepo[]> {
  const tj = nodePath.resolve(tjBase);
  const repos = await listLemonadeRepos(lemonadeBase);
  const out: LemonadeRepo[] = [];
  for (const r of repos) {
    if (!(await tjHasModel(tj, r.repoId))) out.push(r);
  }
  return out;
}

export interface LemonadeSyncPreview {
  repoId: string;
  rev: string;
  moveCount: number; // Lemonade-only files that would move into Turbo Jumbo
  dedupCount: number; // files Turbo Jumbo already holds — Lemonade copy deleted
}

/** The models a sync would change, each split into files to move vs deduplicate.
 *  Read-only — touches no files; uses the same per-file plan as the executor, so
 *  the preview and the run agree. Models with no actionable files are omitted. */
export async function previewLemonadeSync(
  tjBase: string,
  lemonadeBase: string,
): Promise<LemonadeSyncPreview[]> {
  const tj = nodePath.resolve(tjBase);
  const repos = await listLemonadeRepos(lemonadeBase);
  const out: LemonadeSyncPreview[] = [];
  for (const repo of repos) {
    const entries = await walkSnapshot(
      nodePath.join(repo.dir, 'snapshots', repo.rev),
    );
    let moveCount = 0;
    let dedupCount = 0;
    for (const entry of entries) {
      const {action} = await planFile(tj, repo.repoId, entry);
      if (action === 'move') moveCount++;
      else if (action === 'dedup') dedupCount++;
    }
    if (moveCount + dedupCount > 0)
      out.push({repoId: repo.repoId, rev: repo.rev, moveCount, dedupCount});
  }
  return out;
}

// What syncing a single Lemonade snapshot entry will do, shared by the preview
// and the executor so they can't disagree.
//  - move:           no Turbo Jumbo copy yet — relocate the real file there
//  - dedup:          an identical (same-size) Turbo Jumbo copy exists — drop ours
//  - skip-differs:   a Turbo Jumbo copy exists but differs in size — leave it
//  - already-linked: the entry is already a symlink
type FileAction = 'move' | 'dedup' | 'skip-differs' | 'already-linked';

interface FilePlan {
  dst: string; // the Turbo Jumbo path this entry maps to
  action: FileAction;
}

/** Decide what to do with one snapshot entry. Files are matched by size — the
 *  app validates by size and never live-hashes; for the same in-repo path from
 *  the same repo, equal size means equal bytes. */
async function planFile(
  tj: string,
  repoId: string,
  entry: SnapshotEntry,
): Promise<FilePlan> {
  const dst = nodePath.join(tj, repoId, entry.repoPath);
  if (entry.isSymlink) return {dst, action: 'already-linked'};
  const dstStat = await fsp.stat(dst).catch(() => null);
  if (!dstStat) return {dst, action: 'move'};
  const srcSize = (await fsp.stat(entry.full)).size;
  return {dst, action: srcSize === dstStat.size ? 'dedup' : 'skip-differs'};
}

/** Move a file to `dst`, falling back to copy+unlink across filesystems. */
async function moveFile(src: string, dst: string): Promise<void> {
  await fsp.mkdir(nodePath.dirname(dst), {recursive: true});
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dst);
    await fsp.unlink(src);
  }
}

/**
 * Sync one Lemonade repo into Turbo Jumbo so a single copy on disk serves both.
 * Per snapshot file: a file with no Turbo Jumbo copy is **moved** there and the
 * Lemonade entry becomes a symlink to it; a file Turbo Jumbo already holds an
 * identical (same-size) copy of is **deduplicated** — the Lemonade copy is
 * deleted and replaced with a symlink; a file Turbo Jumbo holds a *different*
 * copy of, or one already symlinked, is left untouched (no overwrite, no data
 * loss). Moved files are recorded in `tjmodel.json` with the snapshot revision
 * as the model's `repoCommit`; deduplicated files already have a Turbo Jumbo
 * sidecar and aren't rewritten.
 */
export async function syncLemonadeRepo(
  tjBase: string,
  repo: LemonadeRepo,
): Promise<SyncModelResult> {
  const tj = nodePath.resolve(tjBase);
  const snapshotDir = nodePath.join(repo.dir, 'snapshots', repo.rev);
  const entries = await walkSnapshot(snapshotDir);
  const files: SyncFileResult[] = [];
  const movedEntries: TjModelFile[] = [];

  for (const entry of entries) {
    try {
      const {dst, action} = await planFile(tj, repo.repoId, entry);
      if (action === 'already-linked') {
        files.push({repoPath: entry.repoPath, status: 'already-linked'});
        continue;
      }
      if (action === 'skip-differs') {
        files.push({
          repoPath: entry.repoPath,
          status: 'skipped',
          message: 'a different file exists in Turbo Jumbo',
        });
        continue;
      }
      if (action === 'dedup') {
        // Turbo Jumbo already holds an identical copy: drop the Lemonade
        // duplicate and point its slot at the Turbo Jumbo file (absolute, so
        // the link resolves wherever it's read from).
        await fsp.unlink(entry.full);
        await fsp.symlink(dst, entry.full);
        files.push({repoPath: entry.repoPath, status: 'deduplicated'});
        continue;
      }
      // move: relocate the only copy into Turbo Jumbo, then symlink it back.
      await moveFile(entry.full, dst);
      await fsp.symlink(dst, entry.full);
      const size = (await fsp.stat(dst)).size;
      movedEntries.push({
        path: entry.repoPath,
        originUrl: `https://huggingface.co/${repo.repoId}/blob/main/${entry.repoPath}`,
        sourceSize: 0,
        computedSize: size,
        sourceSha256: '',
        computedSha256: '',
      });
      files.push({repoPath: entry.repoPath, status: 'linked'});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(
        `[lemonade-sync] ${repo.repoId}/${entry.repoPath}: ${message}`,
      );
      files.push({repoPath: entry.repoPath, status: 'error', message});
    }
  }

  // Record provenance for what landed in Turbo Jumbo: the snapshot revision is
  // the repo HEAD, stored as the model-level repoCommit.
  for (const entry of movedEntries) {
    try {
      await upsertFileMeta(tj, repo.repoId, repo.repoId, entry, {id: repo.rev});
    } catch (e) {
      logger.warn(
        `[lemonade-sync] sidecar for ${repo.repoId}/${entry.path}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return {repoId: repo.repoId, rev: repo.rev, files};
}

/**
 * Sync every Lemonade model into Turbo Jumbo: move Lemonade-only files in, and
 * deduplicate files Turbo Jumbo already holds. Idempotent — a model whose files
 * are all symlinked already (or all differ from Turbo Jumbo) makes no change and
 * is omitted. Returns a per-model, per-file summary of the models that changed.
 */
export async function syncLemonadeToTurboJumbo(
  tjBase: string,
  lemonadeBase: string,
): Promise<SyncModelResult[]> {
  const repos = await listLemonadeRepos(lemonadeBase);
  const out: SyncModelResult[] = [];
  for (const repo of repos) {
    const result = await syncLemonadeRepo(tjBase, repo);
    if (
      result.files.some(
        (f) => f.status === 'linked' || f.status === 'deduplicated',
      )
    ) {
      out.push(result);
    }
  }
  return out;
}
