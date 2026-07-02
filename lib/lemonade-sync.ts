import {promises as fsp} from 'fs';
import nodePath from 'path';
import {logger} from '@/lib/logger';
import {
  MODEL_SIDECAR_NAME,
  readModelSidecar,
  upsertFileMeta,
  type TjModelFile,
} from '@/lib/model-sidecar';

// Sync Lemonade and Turbo Jumbo so a single copy on disk serves both, via the
// Lemonade HuggingFace-cache layout `models--<org>--<repo>/snapshots/<rev>/…`
// pointing at Turbo Jumbo's flat mirror `<tj>/<org>/<repo>/…`:
//  - a file only in Lemonade is moved into Turbo Jumbo and symlinked back;
//  - a file Turbo Jumbo already holds an identical copy of has its Lemonade
//    duplicate deleted and symlinked;
//  - a catalog model Turbo Jumbo has but Lemonade hasn't cached is materialized
//    into the Lemonade cache as symlinks (see materializeLemonadeModel).

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface LemonadeRepo {
  repoId: string;
  rev: string; // snapshot revision (repo HEAD) — names the snapshots/<rev>/ dir
  dir: string; // absolute path to the models--<org>--<repo> directory
}

export type SyncFileStatus =
  | 'linked' // moved to Turbo Jumbo and replaced with a symlink
  | 'deduplicated' // an identical Turbo Jumbo copy existed — Lemonade dup deleted, symlinked
  | 'materialized' // Turbo Jumbo had it, Lemonade didn't — created a Lemonade symlink
  | 'already-linked' // the Lemonade entry was already a symlink — left alone
  | 'stale-removed' // the entry was a dangling symlink (target gone) — deleted
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
  rev: string; // empty when blocked — there is no revision to show
  moveCount: number; // Lemonade-only files that would move into Turbo Jumbo
  dedupCount: number; // files Turbo Jumbo already holds — Lemonade copy deleted
  linkCount: number; // files to materialize as Lemonade symlinks into Turbo Jumbo
  staleCount: number; // dangling snapshot symlinks (target gone) to delete
  // A model the sync wants to materialize but can't: its sidecar records no
  // repoCommit, so there's no revision to name the snapshot dir. Surfaced so
  // "nothing to sync" isn't conflated with "can't sync"; a run skips it.
  blocked?: 'no-revision';
}

/** The models a sync would change, split into files to move, deduplicate, or
 *  link (materialize). Read-only — touches no files; uses the same per-file
 *  plans as the executor, so the preview and the run agree. Models with no
 *  actionable files are omitted. */
export async function previewLemonadeSync(
  tjBase: string,
  lemonadeBase: string,
  catalogRepoIds: string[] = [],
): Promise<LemonadeSyncPreview[]> {
  const tj = nodePath.resolve(tjBase);
  const out: LemonadeSyncPreview[] = [];
  // Cache repos: move/dedup.
  for (const repo of await listLemonadeRepos(lemonadeBase)) {
    const entries = await walkSnapshot(
      nodePath.join(repo.dir, 'snapshots', repo.rev),
    );
    let moveCount = 0;
    let dedupCount = 0;
    let staleCount = 0;
    for (const entry of entries) {
      const {action} = await planFile(tj, repo.repoId, entry);
      if (action === 'move') moveCount++;
      else if (action === 'dedup') dedupCount++;
      else if (action === 'stale') staleCount++;
    }
    if (moveCount + dedupCount + staleCount > 0)
      out.push({
        repoId: repo.repoId,
        rev: repo.rev,
        moveCount,
        dedupCount,
        linkCount: 0,
        staleCount,
      });
  }
  // Catalog models to materialize into Lemonade.
  for (const repoId of catalogRepoIds) {
    const plan = await planMaterialize(tj, lemonadeBase, repoId);
    if (!plan) continue;
    if (plan.rev === null) {
      out.push({
        repoId,
        rev: '',
        moveCount: 0,
        dedupCount: 0,
        linkCount: 0,
        staleCount: 0,
        blocked: 'no-revision',
      });
    } else {
      out.push({
        repoId,
        rev: plan.rev,
        moveCount: 0,
        dedupCount: 0,
        linkCount: plan.repoPaths.length,
        staleCount: 0,
      });
    }
  }
  return out;
}

// What syncing a single Lemonade snapshot entry will do, shared by the preview
// and the executor so they can't disagree.
//  - move:           no Turbo Jumbo copy yet — relocate the real file there
//  - dedup:          an identical (same-size) Turbo Jumbo copy exists — drop ours
//  - skip-differs:   a Turbo Jumbo copy exists but differs in size — leave it
//  - already-linked: the entry is already a symlink that still resolves
//  - stale:          the entry is a dangling symlink (its target is gone)
type FileAction =
  'move' | 'dedup' | 'skip-differs' | 'already-linked' | 'stale';

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
  if (entry.isSymlink) {
    // stat follows the link: a failure means the target no longer exists (e.g.
    // the Turbo Jumbo file it pointed at was deleted) — the link is stale.
    const resolves = await fsp
      .stat(entry.full)
      .then(() => true)
      .catch(() => false);
    return {dst, action: resolves ? 'already-linked' : 'stale'};
  }
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

async function exists(p: string): Promise<boolean> {
  return fsp
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/** The Lemonade cache directory for a repo: `<lem>/models--<org>--<repo>`. */
function lemonadeRepoDir(lemonadeBase: string, repoId: string): string {
  return nodePath.join(
    nodePath.resolve(lemonadeBase),
    `models--${repoId.replaceAll('/', '--')}`,
  );
}

/** Real model files under a Turbo Jumbo model dir, as repo-relative paths, with
 *  our own sidecars (`tjmodel.json`, `*.tjmeta.json`) excluded. */
async function listTjFiles(tjModelDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const e of entries) {
      const full = nodePath.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = nodePath.relative(tjModelDir, full);
      if (rel === MODEL_SIDECAR_NAME || rel.endsWith('.tjmeta.json')) continue;
      out.push(rel);
    }
  }
  await walk(tjModelDir);
  return out;
}

/** What materializing `repoId` into Lemonade would entail. Null when there's
 *  nothing to do: Lemonade already has a cache entry, or Turbo Jumbo doesn't
 *  hold the model. `rev: null` when the model is a candidate but its sidecar
 *  records no repoCommit — nothing can name the snapshot dir, so it's blocked
 *  rather than actionable. Shared by the preview and the executor so they
 *  agree. */
async function planMaterialize(
  tj: string,
  lemonadeBase: string,
  repoId: string,
): Promise<{rev: string | null; repoPaths: string[]} | null> {
  if (await exists(lemonadeRepoDir(lemonadeBase, repoId))) return null;
  const repoPaths = await listTjFiles(nodePath.join(tj, repoId));
  if (repoPaths.length === 0) return null;
  const sidecar = await readModelSidecar(tj, repoId);
  return {rev: sidecar?.repoCommit ?? null, repoPaths};
}

/**
 * Mirror a Turbo-Jumbo-resident model into Lemonade's cache as symlinks: for a
 * model Lemonade's catalog lists and Turbo Jumbo already holds but Lemonade
 * hasn't cached, recreate `models--<org>--<repo>/snapshots/<rev>/<repoPath>` as
 * links to the Turbo Jumbo files, plus `refs/main`, so Lemonade sees it as
 * downloaded. The revision is the model's recorded `repoCommit` (the repo HEAD).
 * Returns null when there's nothing to do (see `planMaterialize`).
 */
export async function materializeLemonadeModel(
  tjBase: string,
  lemonadeBase: string,
  repoId: string,
): Promise<SyncModelResult | null> {
  const tj = nodePath.resolve(tjBase);
  const plan = await planMaterialize(tj, lemonadeBase, repoId);
  if (!plan || plan.rev === null) return null;
  const {rev, repoPaths} = plan;
  const snapshotDir = nodePath.join(
    lemonadeRepoDir(lemonadeBase, repoId),
    'snapshots',
    rev,
  );
  const files: SyncFileResult[] = [];
  for (const repoPath of repoPaths) {
    const link = nodePath.join(snapshotDir, repoPath);
    const target = nodePath.join(tj, repoId, repoPath); // absolute
    try {
      await fsp.mkdir(nodePath.dirname(link), {recursive: true});
      await fsp.symlink(target, link);
      files.push({repoPath, status: 'materialized'});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(
        `[lemonade-sync] materialize ${repoId}/${repoPath}: ${message}`,
      );
      files.push({repoPath, status: 'error', message});
    }
  }
  // Pin the branch to the revision, as huggingface_hub's cache does.
  try {
    const refsDir = nodePath.join(
      lemonadeRepoDir(lemonadeBase, repoId),
      'refs',
    );
    await fsp.mkdir(refsDir, {recursive: true});
    await fsp.writeFile(nodePath.join(refsDir, 'main'), rev);
  } catch (e) {
    logger.warn(
      `[lemonade-sync] refs/main for ${repoId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return {repoId, rev, files};
}

/**
 * Sync one Lemonade repo into Turbo Jumbo so a single copy on disk serves both.
 * Per snapshot file: a file with no Turbo Jumbo copy is **moved** there and the
 * Lemonade entry becomes a symlink to it; a file Turbo Jumbo already holds an
 * identical (same-size) copy of is **deduplicated** — the Lemonade copy is
 * deleted and replaced with a symlink; a file Turbo Jumbo holds a *different*
 * copy of, or one already symlinked, is left untouched (no overwrite, no data
 * loss); a **stale** symlink — one whose target no longer exists — is deleted,
 * since it only misleads Lemonade's cache scan. Moved files are recorded in
 * `tjmodel.json` with the snapshot revision
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
      if (action === 'stale') {
        // The link's target is gone (e.g. its Turbo Jumbo file was deleted);
        // a dangling link only misleads Lemonade's cache scan, so drop it.
        await fsp.unlink(entry.full);
        files.push({repoPath: entry.repoPath, status: 'stale-removed'});
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
 * Sync Lemonade and Turbo Jumbo so a single copy on disk serves both. Two
 * passes: (1) consolidate Lemonade's on-disk cache into Turbo Jumbo — move
 * Lemonade-only files in, deduplicate files Turbo Jumbo already holds; (2) for
 * each catalog repo in `catalogRepoIds` that Turbo Jumbo has but Lemonade hasn't
 * cached, materialize a Lemonade cache entry of symlinks into Turbo Jumbo.
 * Idempotent — a model needing no change is omitted. Returns a per-model,
 * per-file summary of the models that changed.
 */
export async function syncLemonadeToTurboJumbo(
  tjBase: string,
  lemonadeBase: string,
  catalogRepoIds: string[] = [],
): Promise<SyncModelResult[]> {
  const out: SyncModelResult[] = [];
  // Pass 1: Lemonade cache → Turbo Jumbo (move + dedup).
  for (const repo of await listLemonadeRepos(lemonadeBase)) {
    const result = await syncLemonadeRepo(tjBase, repo);
    if (
      result.files.some(
        (f) =>
          f.status === 'linked' ||
          f.status === 'deduplicated' ||
          f.status === 'stale-removed',
      )
    ) {
      out.push(result);
    }
  }
  // Pass 2: Turbo Jumbo → Lemonade cache (materialize catalog models as links).
  for (const repoId of catalogRepoIds) {
    const result = await materializeLemonadeModel(tjBase, lemonadeBase, repoId);
    if (result?.files.some((f) => f.status === 'materialized'))
      out.push(result);
  }
  return out;
}
