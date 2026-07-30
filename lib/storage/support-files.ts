import {promises as fsp} from 'fs';
import nodePath from 'path';
import {isWeightFile} from '@/lib/models/weight-files';
import {MODEL_SIDECAR_NAME, TJMETA_SUFFIX} from '@/lib/models/sidecar-types';

/**
 * The support files that must travel with the given weight files: everything
 * else on disk in the same model directories — config.json, tokenizer files,
 * a safetensors index — without which a whole-repo model's copy can't be
 * loaded. The weight scan (and so the copy selection) only tracks weight
 * files, so a copy built from selected paths alone would strand these.
 *
 * Excluded: other weight files (a selection of one quant must not drag its
 * siblings along), sidecars (`tjmodel.json`, `*.tjmeta.json` — the copy's
 * meta-propagation channel owns those), and dot-entries (`.cache/…`).
 * Paths that escape `baseDir` or whose directory is gone yield nothing.
 */
export async function expandSupportFiles(
  baseDir: string,
  paths: string[],
): Promise<Array<{path: string; size: number}>> {
  const base = nodePath.resolve(baseDir);
  const known = new Set(paths);
  const dirs = new Set<string>();
  for (const p of paths) {
    const dir = nodePath.dirname(nodePath.resolve(base, p));
    if (dir.startsWith(base + nodePath.sep)) dirs.add(dir);
  }

  const out: Array<{path: string; size: number}> = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, {withFileTypes: true});
    } catch {
      return; // gone or unreadable: nothing to expand
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = nodePath.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (isWeightFile(e.name)) continue;
      if (e.name === MODEL_SIDECAR_NAME || e.name.endsWith(TJMETA_SUFFIX))
        continue;
      const rel = nodePath.relative(base, full);
      if (known.has(rel)) continue;
      known.add(rel);
      try {
        out.push({path: rel, size: (await fsp.stat(full)).size});
      } catch {
        /* raced away between readdir and stat: skip */
      }
    }
  };
  for (const dir of dirs) await walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
