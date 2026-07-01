// Parsing for the Lemonade SDK model catalog (server_models.json): a map of
// model name -> {checkpoint, recipe, size, ...}. Only `llamacpp`-recipe
// entries matter here — they are single GGUF files in HF repos, which is what
// this app stores; other recipes (ONNX, whisper, SD) are multi-file layouts.

/** One downloadable GGUF model from the Lemonade catalog. */
export interface LemonadeModel {
  name: string;
  repoId: string; // HF repo the checkpoint lives in
  variant: string | null; // quant token (Q4_0) or exact filename; null = whole repo
  mmproj: string | null; // companion projector file for vision models
  suggested: boolean;
  labels: string[];
  sizeGb: number;
}

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Split a Lemonade checkpoint (`org/repo` or `org/repo:variant`) into its HF
 * repo and optional variant. The variant selects within the repo: a quant
 * token like `Q4_0`, or an exact `.gguf` filename. Null when the repo part
 * isn't a valid HF id.
 */
export function parseCheckpoint(
  checkpoint: string,
): {repoId: string; variant: string | null} | null {
  const idx = checkpoint.indexOf(':');
  const repoId = idx === -1 ? checkpoint : checkpoint.slice(0, idx);
  const variant = idx === -1 ? null : checkpoint.slice(idx + 1);
  if (!REPO_ID_RE.test(repoId)) return null;
  return {repoId, variant: variant || null};
}

/**
 * The GGUF (llamacpp-recipe) models of a raw Lemonade catalog, in catalog
 * order. Tolerant of malformed entries — the file is fetched from a moving
 * branch head, so unknown shapes are skipped rather than fatal.
 */
export function lemonadeGgufModels(catalog: unknown): LemonadeModel[] {
  if (catalog == null || typeof catalog !== 'object' || Array.isArray(catalog))
    return [];
  const models: LemonadeModel[] = [];
  for (const [name, raw] of Object.entries(catalog)) {
    if (raw == null || typeof raw !== 'object') continue;
    const entry = raw as {
      checkpoint?: unknown;
      recipe?: unknown;
      suggested?: unknown;
      labels?: unknown;
      size?: unknown;
      mmproj?: unknown;
    };
    if (entry.recipe !== 'llamacpp') continue;
    if (typeof entry.checkpoint !== 'string') continue;
    const parsed = parseCheckpoint(entry.checkpoint);
    if (!parsed) continue;
    models.push({
      name,
      repoId: parsed.repoId,
      variant: parsed.variant,
      mmproj: typeof entry.mmproj === 'string' ? entry.mmproj : null,
      suggested: entry.suggested === true,
      labels: Array.isArray(entry.labels)
        ? entry.labels.filter((l): l is string => typeof l === 'string')
        : [],
      sizeGb: typeof entry.size === 'number' ? entry.size : 0,
    });
  }
  return models;
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
