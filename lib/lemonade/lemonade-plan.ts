// Resolving a Lemonade selection into the HuggingFace files to download: which
// repo files a model/checkpoint variant picks, grouped into per-repo jobs, and
// which of those are still missing locally.

import type {Model} from '@/lib/models/model-types';
import type {
  Checkpoint,
  OmniCollection,
  RepoJob,
} from '@/lib/lemonade/lemonade-types';

/**
 * The full set of repo checkpoints to fetch for an omni collection: every
 * component's checkpoints, in component order, de-duped so a repo+variant shared
 * by two components is fetched once.
 */
export function collectionDownloadPlan(
  collection: OmniCollection,
): Checkpoint[] {
  const seen = new Set<string>();
  const plan: Checkpoint[] = [];
  for (const component of collection.components) {
    for (const cp of component.checkpoints) {
      const key = `${cp.repoId}::${cp.variant ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plan.push(cp);
    }
  }
  return plan;
}

/**
 * Group checkpoints into one job per repo, preserving first-seen order and
 * de-duping variants — so a repo named by several checkpoints (a model and its
 * mmproj, say) is fetched once with every variant resolved against one listing.
 */
export function planRepoJobs(checkpoints: Checkpoint[]): RepoJob[] {
  const order: string[] = [];
  const byRepo = new Map<string, Array<string | null>>();
  for (const cp of checkpoints) {
    let variants = byRepo.get(cp.repoId);
    if (!variants) {
      variants = [];
      byRepo.set(cp.repoId, variants);
      order.push(cp.repoId);
    }
    if (!variants.includes(cp.variant)) variants.push(cp.variant);
  }
  return order.map((repoId) => ({repoId, variants: byRepo.get(repoId)!}));
}

const isMmproj = (name: string) => name.toLowerCase().startsWith('mmproj');

/**
 * The repo file paths a Lemonade model resolves to. An exact-filename variant
 * picks that file; a quant token picks the `.gguf` files carrying it
 * (case-insensitive, shards included, companion mmproj files excluded); no
 * variant picks every non-mmproj `.gguf` (single-quant repos list the whole
 * checkpoint). The model's own `mmproj` file, when named, rides along.
 */
export function matchVariantFiles(
  files: Array<{path: string; size: number}>,
  variant: string | null,
  mmproj: string | null,
): string[] {
  const ggufs = files.filter((f) => f.path.toLowerCase().endsWith('.gguf'));
  let picked: string[];
  if (variant && variant.toLowerCase().endsWith('.gguf')) {
    picked = ggufs
      .filter((f) => {
        const name = f.path.split('/').pop() ?? f.path;
        return name.toLowerCase() === variant.toLowerCase();
      })
      .map((f) => f.path);
  } else if (variant) {
    const needle = variant.toLowerCase();
    picked = ggufs
      .filter((f) => {
        const name = f.path.split('/').pop() ?? f.path;
        return !isMmproj(name) && name.toLowerCase().includes(needle);
      })
      .map((f) => f.path);
  } else {
    picked = ggufs
      .filter((f) => !isMmproj(f.path.split('/').pop() ?? f.path))
      .map((f) => f.path);
  }
  if (mmproj) {
    const extra = ggufs.find((f) => {
      const name = f.path.split('/').pop() ?? f.path;
      return name.toLowerCase() === mmproj.toLowerCase();
    });
    if (extra && !picked.includes(extra.path)) picked.push(extra.path);
  }
  return picked;
}

// A variant naming an exact file ends in an extension; a quant token doesn't.
export const FILENAME_VARIANT_RE = /\.[A-Za-z0-9]+$/;
export const baseName = (p: string) => p.split('/').pop() ?? p;

/**
 * The repo file paths one checkpoint resolves to — the generalization of
 * `matchVariantFiles` for omni components, which span more than GGUF:
 *  - a quant token picks the `.gguf` files carrying it (mmproj excluded);
 *  - an exact filename picks that file of ANY extension, matched by full path
 *    or basename so a subdir-qualified name (e.g. `split_files/vae/x.safetensors`)
 *    resolves whether or not the catalog included the subdir;
 *  - a null variant takes the whole repo (a kokoro ONNX checkpoint, say).
 */
export function resolveCheckpointFiles(
  files: Array<{path: string; size: number}>,
  variant: string | null,
): string[] {
  if (variant == null) return files.map((f) => f.path);
  if (FILENAME_VARIANT_RE.test(variant)) {
    const wantPath = variant.toLowerCase();
    const wantBase = baseName(variant).toLowerCase();
    return files
      .filter(
        (f) =>
          f.path.toLowerCase() === wantPath ||
          baseName(f.path).toLowerCase() === wantBase,
      )
      .map((f) => f.path);
  }
  const needle = variant.toLowerCase();
  return files
    .filter((f) => {
      const name = baseName(f.path).toLowerCase();
      return name.endsWith('.gguf') && !isMmproj(name) && name.includes(needle);
    })
    .map((f) => f.path);
}

/**
 * Of a variant's repo file paths, the ones not already present in the local
 * scan for `repoId` — the files a download still needs to fetch. Presence is
 * judged per file by existence (no size check): a non-`missing` single file
 * contributes its basename; a split group contributes each present shard's
 * basename. Matching is by basename, so `paths` is expected to be the per-shard
 * repo paths produced by `matchVariantFiles`, not representative names. An empty
 * result means every file is already present locally.
 */
export function missingVariantFiles(
  paths: string[],
  localModels: Model[],
  repoId: string,
): string[] {
  const basename = (p: string) => p.split('/').pop() ?? p;
  const present = new Set<string>();
  for (const m of localModels) {
    if (m.name !== repoId) continue;
    for (const f of m.files) {
      if (f.isSplit) {
        for (const s of f.files) present.add(basename(s.path));
      } else if (!f.missing) {
        present.add(basename(f.filename));
      }
    }
  }
  return paths.filter((fp) => !present.has(basename(fp)));
}
