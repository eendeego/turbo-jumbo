import nodePath from 'path';
import {promises as fsp} from 'fs';
import {readModelSidecar} from '@/lib/models/model-sidecar';
import {MODEL_SIDECAR_NAME} from '@/lib/models/sidecar-types';

/**
 * The SHA256 a model's sidecar already recorded for one of its files, when
 * that record can still be trusted — so a comparison between two copies can
 * answer from `tjmodel.json` instead of re-reading gigabytes through the
 * slowest disk in the system.
 *
 * Trust is deliberately narrow. The record is used only when the file's size
 * still matches the recorded `computedSize` (a truncated or resumed copy
 * changes it) and the file has not been written since the sidecar was (its
 * mtime is not newer). Anything else — no sidecar, no recorded hash (a
 * Lemonade-consolidated model records none), a missing file — returns null,
 * and the caller falls back to hashing the bytes.
 *
 * `relPath` is relative to `basePath` (the models or cold-storage root); the
 * sidecar is looked up in the model directory containing the file.
 */
export async function recordedSha256(
  basePath: string,
  relPath: string,
): Promise<string | null> {
  const base = nodePath.resolve(basePath);
  const full = nodePath.resolve(base, relPath);
  if (!full.startsWith(base + nodePath.sep)) return null;

  let fileStat;
  try {
    fileStat = await fsp.stat(full);
  } catch {
    return null;
  }

  // Walk up to the model directory holding the sidecar, mirroring
  // readFileMetaByPath — but statting the sidecar too, since trusting its
  // record depends on when it was written relative to the file.
  let dir = nodePath.dirname(nodePath.relative(base, full));
  while (dir && dir !== '.') {
    const model = await readModelSidecar(base, dir);
    if (model) {
      const key = nodePath.relative(
        nodePath.resolve(base, dir),
        nodePath.resolve(base, relPath),
      );
      const entry = model.files.find((f) => f.path === key);
      if (!entry?.computedSha256) return null;
      if (entry.computedSize !== fileStat.size) return null;
      let sidecarStat;
      try {
        sidecarStat = await fsp.stat(
          nodePath.join(base, dir, MODEL_SIDECAR_NAME),
        );
      } catch {
        return null;
      }
      if (fileStat.mtimeMs > sidecarStat.mtimeMs) return null;
      return entry.computedSha256;
    }
    dir = nodePath.dirname(dir);
  }
  return null;
}
