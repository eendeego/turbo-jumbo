import {promises as fsp} from 'fs';
import nodePath from 'path';
import {logger} from '@/lib/logger';
import {upsertFileMeta, type TjModelFile} from '@/lib/model-sidecar';

// Sync Lemonade's HuggingFace-cache models into Turbo Jumbo's flat mirror: move
// the real files into `<tj>/<org>/<repo>/<repoPath>` and leave the Lemonade
// `models--<org>--<repo>/snapshots/<rev>/<repoPath>` entries as symlinks into
// Turbo Jumbo. A single copy on disk, owned by Turbo Jumbo, served to both.

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface LemonadeRepo {
  repoId: string;
  rev: string; // snapshot revision (repo HEAD) — names the snapshots/<rev>/ dir
  dir: string; // absolute path to the models--<org>--<repo> directory
}

export type SyncFileStatus =
  | 'linked' // moved to Turbo Jumbo and replaced with a symlink
  | 'already-linked' // the Lemonade entry was already a symlink — left alone
  | 'skipped' // a Turbo Jumbo copy already exists — not overwritten
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
  fileCount: number; // real (not-yet-linked) files that would move
}

/** The Lemonade-only models a sync would move, each with its movable file count.
 *  Read-only — touches no files. */
export async function previewLemonadeSync(
  tjBase: string,
  lemonadeBase: string,
): Promise<LemonadeSyncPreview[]> {
  const candidates = await findLemonadeOnlyRepos(tjBase, lemonadeBase);
  const out: LemonadeSyncPreview[] = [];
  for (const repo of candidates) {
    const entries = await walkSnapshot(
      nodePath.join(repo.dir, 'snapshots', repo.rev),
    );
    out.push({
      repoId: repo.repoId,
      rev: repo.rev,
      fileCount: entries.filter((e) => !e.isSymlink).length,
    });
  }
  return out;
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
 * Sync one Lemonade repo into Turbo Jumbo: move each real snapshot file into the
 * flat mirror and replace the Lemonade entry with a symlink to it. Files already
 * symlinked, or whose Turbo Jumbo target already exists, are left untouched (no
 * overwrite, no data loss). Writes a `tjmodel.json` recording the moved files
 * and the snapshot revision as the model's `repoCommit`.
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
    if (entry.isSymlink) {
      files.push({repoPath: entry.repoPath, status: 'already-linked'});
      continue;
    }
    const dst = nodePath.join(tj, repo.repoId, entry.repoPath);
    try {
      // Never clobber an existing Turbo Jumbo copy — that file isn't ours to
      // replace, and the bytes might differ.
      const exists = await fsp
        .access(dst)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        files.push({
          repoPath: entry.repoPath,
          status: 'skipped',
          message: 'a Turbo Jumbo copy already exists',
        });
        continue;
      }
      await moveFile(entry.full, dst);
      // The source path is now free; point it back at the moved file (absolute,
      // so it resolves regardless of where the link is read from).
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
 * Sync every Lemonade-only model into Turbo Jumbo. Idempotent: a model already
 * present in Turbo Jumbo (including one synced on a prior run, whose Lemonade
 * files are now symlinks) is skipped. Returns a per-model, per-file summary.
 */
export async function syncLemonadeToTurboJumbo(
  tjBase: string,
  lemonadeBase: string,
): Promise<SyncModelResult[]> {
  const candidates = await findLemonadeOnlyRepos(tjBase, lemonadeBase);
  const out: SyncModelResult[] = [];
  for (const repo of candidates) {
    out.push(await syncLemonadeRepo(tjBase, repo));
  }
  return out;
}
