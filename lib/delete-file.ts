import {promises as fsp} from 'fs';
import path from 'path';
import {pathImpliedRepo} from '@/lib/audit-verdict';
import {parseHubCachePath} from '@/lib/hf-cache';
import {repoIdFromModelUrl} from '@/lib/model-name';
import {modelDirForRepo, removeFileMeta} from '@/lib/model-sidecar';
import {metaPath, readMetaResolved} from '@/lib/tjmeta';

/**
 * Delete a model file along with its provenance records, then prune the
 * directories the deletion emptied: the file's entry leaves its model sidecar
 * (`tjmodel.json`, which `removeFileMeta` deletes outright when no entries
 * remain), a legacy per-file `.tjmeta.json` is removed, and every ancestor
 * directory up to (but never including) `basePath` that is left empty — or
 * holding only the hf CLI's `.cache` download bookkeeping — is removed. So
 * deleting a model's last file removes the whole directory husk instead of
 * leaving a ghost the audit and Lemonade sync would keep tripping over.
 */
export async function deleteFileWithMeta(
  basePath: string,
  relPath: string,
): Promise<void> {
  const base = path.resolve(basePath);
  const full = path.join(base, relPath);

  // Read provenance before deleting — it names the sidecar that owns the file.
  const meta = await readMetaResolved(base, relPath);

  await fsp.rm(full, {force: true});
  await fsp.rm(metaPath(full), {force: true});

  // Drop the file's entry from its model sidecar. The owning repo comes from
  // the recorded provenance when there is one, else from the file's placement.
  const repoId =
    (meta ? repoIdFromModelUrl(meta.modelUrl) : '') ||
    parseHubCachePath(relPath)?.repoId ||
    pathImpliedRepo(relPath)?.repoId ||
    '';
  const loc = repoId ? modelDirForRepo(relPath, repoId) : null;
  if (loc) await removeFileMeta(base, loc.dir, loc.key);

  await pruneEmptyDirs(base, path.dirname(full));
}

/** Remove `dir` and its ancestors (up to, excluding, `base`) while each is
 *  empty; a directory holding only the hf CLI's `.cache` bookkeeping counts
 *  as empty. Stops at the first directory with real content. */
async function pruneEmptyDirs(base: string, dir: string): Promise<void> {
  for (
    let d = path.resolve(dir);
    d !== base && d.startsWith(base + path.sep);
    d = path.dirname(d)
  ) {
    let entries: string[];
    try {
      entries = await fsp.readdir(d);
    } catch {
      return; // already gone or unreadable — nothing to prune
    }
    if (entries.length === 1 && entries[0] === '.cache') {
      await fsp.rm(path.join(d, '.cache'), {recursive: true, force: true});
      entries = [];
    }
    if (entries.length > 0) return;
    try {
      await fsp.rmdir(d);
    } catch {
      return; // e.g. a file appeared concurrently — leave it be
    }
  }
}
