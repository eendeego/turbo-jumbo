import type {Model} from '@/lib/models/models';
import type {ModelRow} from '@/lib/models/model-row';
import {isMmprojFilename} from '@/lib/models/model-name';

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
 * The on-disk size of every file in `models`, keyed by `fileJoinKey` (shards
 * count individually). Lets a presence check compare a destination copy's size
 * against the source's — a smaller copy is incomplete, not "already present".
 */
export function fileSizesByKey(models: Model[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const m of models) {
    for (const f of m.files) {
      const entries = f.isSplit
        ? f.files.map((s) => ({path: s.path, size: s.size}))
        : [{path: f.path, size: f.size}];
      for (const e of entries) {
        sizes.set(fileJoinKey(m.name, fileBasename(e.path)), e.size);
      }
    }
  }
  return sizes;
}

/**
 * Every file join key present on the peer (shards count individually). The
 * models table joins on these to decide which local rows the peer has — both
 * for the presence tokens and for filtering rows on a peer's tab.
 */
export function peerFileKeys(models: Model[]): Set<string> {
  return new Set(fileSizesByKey(models).keys());
}

/**
 * Whether every selected file already exists *complete* in `destModels`. Joins
 * on `fileJoinKey`, so generic and mmproj basenames are qualified by model — a
 * destination holding a different model's `mmproj-F16.gguf` doesn't count this
 * model's projector as already present. A file carrying its source `size`
 * counts as present only when the destination copy is at least that large: a
 * smaller copy is an incomplete transfer (e.g. one interrupted partway), so
 * re-copying it must stay available. Gates a copy destination checkbox.
 */
export function allFilesPresent(
  files: Array<{model: string; filename: string; size?: number}>,
  destModels: Model[],
): boolean {
  const destSizes = fileSizesByKey(destModels);
  return files.every((f) => {
    const destSize = destSizes.get(fileJoinKey(f.model, f.filename));
    if (destSize === undefined) return false;
    return f.size == null || destSize >= f.size;
  });
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
