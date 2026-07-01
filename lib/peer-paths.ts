import type {Model} from './models';
import type {ModelRow} from '@/components/models/models-table-client';
import {isMmprojFilename} from '@/lib/model-name';

// A file's basename is the identity hosts usually agree on: model names are
// derived per host (the sidecar's org/repo when one exists, otherwise the
// filename), so the same file can be named "Jan-nano-128k" on one host and
// "unsloth/Jan-nano-128k-GGUF" on the other — e.g. after an audit Fix wrote a
// sidecar and relocated it on one side only.
export const fileBasename = (p: string) => p.split('/').pop() ?? p;

// The standard generic weight filenames HuggingFace repos share. These don't
// identify a model on their own, so two different repos both contain e.g.
// `model.safetensors` — joining on the basename alone would conflate them.
const GENERIC_WEIGHT_RE =
  /^(model|pytorch_model|tf_model|flax_model|consolidated|diffusion_pytorch_model|adapter_model)(-\d{5}-of-\d{5})?\.(safetensors|bin)$/i;

/**
 * The cross-host join key for a file. A specific basename (GGUF, dtype-tagged)
 * identifies its model, so it joins on its own — preserving matches when hosts
 * name the model differently. A generic weight basename collides between repos,
 * so it's qualified by the (now repo-derived) model name; a different repo's
 * same-named file then has a different key and won't be conflated.
 */
export function fileJoinKey(modelName: string, basename: string): string {
  return GENERIC_WEIGHT_RE.test(basename) || isMmprojFilename(basename)
    ? `${modelName} ${basename}`
    : basename;
}

/**
 * Every file join key present on the peer (shards count individually). The
 * models table joins on these to decide which local rows the peer has — both
 * for the presence tokens and for filtering rows on a peer's tab.
 */
export function peerFileKeys(models: Model[]): Set<string> {
  const keys = new Set<string>();
  for (const m of models) {
    for (const f of m.files) {
      const paths = f.isSplit ? f.files.map((s) => s.path) : [f.path];
      for (const p of paths) keys.add(fileJoinKey(m.name, fileBasename(p)));
    }
  }
  return keys;
}

/**
 * Whether every selected file already exists in `destModels`. Joins on
 * `fileJoinKey`, so generic and mmproj basenames are qualified by model — a
 * destination holding a different model's `mmproj-F16.gguf` doesn't count this
 * model's projector as already present. Gates a copy destination checkbox.
 */
export function allFilesPresent(
  files: Array<{model: string; filename: string}>,
  destModels: Model[],
): boolean {
  const destKeys = peerFileKeys(destModels);
  return files.every((f) => destKeys.has(fileJoinKey(f.model, f.filename)));
}

/**
 * Replace each quant's paths with the peer's own paths for that quant. File
 * operations on a peer tab (audit, copy, delete) resolve paths on the peer,
 * whose storage layout can differ from the local one — the same file can sit
 * at a bare path on one host and under <repoId>/ on another.
 *
 * Files are joined by `fileJoinKey` (see above), the same identity the peer
 * presence tokens use, so every row visible on a peer tab gets mapped — without
 * a different repo's same-named generic file being mistaken for a match. Quants
 * the peer doesn't have keep their local paths; they're filtered off peer tabs
 * anyway.
 */
export function withPeerPaths(
  models: ModelRow[],
  peerModels: Model[],
): ModelRow[] {
  const byKey = new Map<string, string[]>();
  for (const m of peerModels) {
    for (const f of m.files) {
      const paths = f.isSplit ? f.files.map((s) => s.path) : [f.path];
      for (const p of paths) {
        const key = fileJoinKey(m.name, fileBasename(p));
        const prev = byKey.get(key);
        if (prev) {
          prev.push(p);
        } else {
          byKey.set(key, [p]);
        }
      }
    }
  }
  return models.map((m) => ({
    ...m,
    quants: m.quants.map((q) => {
      const peerPaths = q.paths.flatMap(
        (p) => byKey.get(fileJoinKey(m.name, fileBasename(p))) ?? [],
      );
      return peerPaths.length > 0 ? {...q, paths: peerPaths} : q;
    }),
  }));
}
