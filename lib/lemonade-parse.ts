// Parsing for the Lemonade SDK model catalog (server_models.json): a map of
// model name -> {checkpoint, recipe, size, ...}. Only `llamacpp`-recipe
// entries matter here — they are single GGUF files in HF repos, which is what
// this app stores; other recipes (ONNX, whisper, SD) are multi-file layouts.

import type {
  CatalogSection,
  Checkpoint,
  LemonadeComponent,
  LemonadeModel,
  OmniCollection,
  OmniManifestRef,
  ParsedLemonade,
} from '@/lib/lemonade-types';

/** Every HuggingFace repo id the catalog references — GGUF models plus the
 *  checkpoints of standalone components and inline collection members. The set
 *  of repos Lemonade knows about, used to decide which Turbo Jumbo models to
 *  mirror back into Lemonade's cache. */
export function catalogRepoIds(parsed: ParsedLemonade): string[] {
  const ids = new Set<string>();
  for (const m of parsed.models) ids.add(m.repoId);
  for (const c of parsed.extraModels)
    for (const cp of c.checkpoints) ids.add(cp.repoId);
  for (const col of parsed.collections)
    for (const c of col.components)
      for (const cp of c.checkpoints) ids.add(cp.repoId);
  return [...ids];
}

/**
 * The display section for a catalog entry, from its recipe and labels. Embedding
 * and reranking models (always llamacpp) split off by label; the GGUF LLMs are
 * their own section (vision GGUFs split out), and the ONNX (Ryzen AI) and vLLM
 * LLM backends each get their own; the remaining recipes map to their modality.
 */
export function catalogSection(
  recipe: string,
  labels: string[],
): CatalogSection {
  if (labels.includes('embeddings')) return 'embeddings';
  if (labels.includes('reranking')) return 'reranking';
  switch (recipe) {
    case 'llamacpp':
      return labels.includes('vision') ? 'vision' : 'llm';
    case 'ryzenai-llm':
      return 'onnx';
    case 'vllm':
      return 'vllm';
    case 'sd-cpp':
      return 'image';
    case 'whispercpp':
    case 'moonshine':
      return 'transcription';
    case 'kokoro':
      return 'tts';
    default:
      return 'other';
  }
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

// A display modality per recipe, for the omni component list. llamacpp is
// split by its vision label; the rest map straight from their recipe.
const RECIPE_MODALITY: Record<string, string> = {
  'sd-cpp': 'image',
  whispercpp: 'transcription',
  moonshine: 'transcription',
  kokoro: 'tts',
  vllm: 'chat',
  'ryzenai-llm': 'chat',
};

function componentModality(recipe: string, labels: string[]): string {
  if (recipe === 'llamacpp')
    return labels.includes('vision') ? 'vision' : 'chat';
  return RECIPE_MODALITY[recipe] ?? recipe;
}

function readLabels(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((l): l is string => typeof l === 'string')
    : [];
}

// The checkpoint roles worth downloading. NPU/cache roles (e.g. `npu_cache`)
// are AMD-device-specific and skipped.
const CHECKPOINT_ROLES = ['main', 'mmproj', 'text_encoder', 'vae'];

// The repos/files a component pulls. Two catalog shapes: a `checkpoints` map of
// role -> "repo:thing" (multi-file recipes like sd-cpp), or a single
// `checkpoint` with an optional sibling `mmproj` filename living in that same
// repo (the llamacpp vision models).
function componentCheckpoints(raw: unknown): Checkpoint[] {
  const e =
    raw && typeof raw === 'object'
      ? (raw as {
          checkpoints?: unknown;
          checkpoint?: unknown;
          mmproj?: unknown;
        })
      : {};
  const out: Checkpoint[] = [];
  if (e.checkpoints && typeof e.checkpoints === 'object') {
    const map = e.checkpoints as Record<string, unknown>;
    for (const role of CHECKPOINT_ROLES) {
      const v = map[role];
      if (typeof v !== 'string') continue;
      const parsed = parseCheckpoint(v);
      if (parsed) out.push(parsed);
    }
  } else if (typeof e.checkpoint === 'string') {
    const parsed = parseCheckpoint(e.checkpoint);
    if (parsed) {
      out.push(parsed);
      if (typeof e.mmproj === 'string')
        out.push({repoId: parsed.repoId, variant: e.mmproj});
    }
  }
  return out;
}

// A collection's total size: its declared size when the catalog gives one,
// else the sum of its components (the inline collections carry no size).
function collectionSize(
  declared: number,
  components: LemonadeComponent[],
): number {
  return declared > 0
    ? declared
    : components.reduce((sum, c) => sum + c.sizeGb, 0);
}

// Build a component from a raw catalog or manifest entry. `downloadableNames`
// is the set of llamacpp model names this app can actually fetch; a llamacpp
// member is downloadable only when it resolves to one.
function toComponent(
  name: string,
  raw: unknown,
  downloadableNames: Set<string>,
): LemonadeComponent {
  const e =
    raw && typeof raw === 'object'
      ? (raw as {recipe?: unknown; size?: unknown; labels?: unknown})
      : {};
  const recipe = typeof e.recipe === 'string' ? e.recipe : 'unknown';
  const labels = readLabels(e.labels);
  return {
    name,
    recipe,
    modality: componentModality(recipe, labels),
    sizeGb: typeof e.size === 'number' ? e.size : 0,
    downloadable: recipe === 'llamacpp' && downloadableNames.has(name),
    checkpoints: componentCheckpoints(raw),
  };
}

// A standalone non-llamacpp catalog entry, as a component. Downloadable when it
// resolves to at least one checkpoint (fetched through the omni-member path).
function toStandaloneModel(name: string, raw: unknown): LemonadeComponent {
  const c = toComponent(name, raw, new Set());
  return {...c, downloadable: c.checkpoints.length > 0};
}

/**
 * Parse the Lemonade catalog into its llamacpp models, every other standalone
 * model (`extraModels`), its inline omni collections (components resolved by
 * catalog-name lookup), and references to the omni collections whose components
 * live in a manifest repo — those are fetched and resolved separately with
 * `collectionFromManifest`.
 */
export function parseLemonade(catalog: unknown): ParsedLemonade {
  const models = lemonadeGgufModels(catalog);
  const downloadableNames = new Set(models.map((m) => m.name));
  const extraModels: LemonadeComponent[] = [];
  const collections: OmniCollection[] = [];
  const manifestRefs: OmniManifestRef[] = [];
  if (catalog && typeof catalog === 'object' && !Array.isArray(catalog)) {
    const map = catalog as Record<string, unknown>;
    for (const [name, raw] of Object.entries(map)) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as {
        recipe?: unknown;
        suggested?: unknown;
        size?: unknown;
        labels?: unknown;
        components?: unknown;
        checkpoint?: unknown;
      };
      // Standalone non-llamacpp models (llamacpp ones are already in `models`).
      if (
        e.recipe !== 'collection.omni' &&
        e.recipe !== 'llamacpp' &&
        typeof e.recipe === 'string'
      ) {
        extraModels.push(toStandaloneModel(name, raw));
        continue;
      }
      if (e.recipe !== 'collection.omni') continue;
      const suggested = e.suggested === true;
      const sizeGb = typeof e.size === 'number' ? e.size : 0;
      const labels = readLabels(e.labels);
      if (Array.isArray(e.components)) {
        const components = e.components
          .filter((c): c is string => typeof c === 'string')
          .map((cname) => toComponent(cname, map[cname], downloadableNames));
        collections.push({
          name,
          suggested,
          sizeGb: collectionSize(sizeGb, components),
          labels,
          components,
        });
      } else if (typeof e.checkpoint === 'string' && e.checkpoint) {
        const parsed = parseCheckpoint(e.checkpoint);
        if (parsed)
          manifestRefs.push({
            name,
            repoId: parsed.repoId,
            suggested,
            sizeGb,
            labels,
          });
      }
    }
  }
  return {models, extraModels, collections, manifestRefs};
}

/**
 * Resolve a manifest-repo omni collection from its fetched `{repo}.json`, whose
 * `models` array fully describes each component. Tolerant of malformed shapes —
 * the manifest is fetched from a moving branch head — so unknown entries are
 * skipped and a missing `models` array yields an empty (still-rendered) group.
 */
export function collectionFromManifest(
  ref: {
    name: string;
    repoId: string;
    suggested: boolean;
    sizeGb: number;
    labels: string[];
  },
  manifest: unknown,
  downloadableNames: Set<string>,
): OmniCollection {
  const components: LemonadeComponent[] = [];
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    const m = manifest as {models?: unknown};
    if (Array.isArray(m.models)) {
      for (const entry of m.models) {
        if (!entry || typeof entry !== 'object') continue;
        const cname = (entry as {model_name?: unknown}).model_name;
        if (typeof cname !== 'string') continue;
        components.push(toComponent(cname, entry, downloadableNames));
      }
    }
  }
  // The manifest lives in the pointer repo as `<repo>.json` (see the route's
  // fetchManifestCollection); link the human-viewable blob page.
  const manifestFile = `${ref.repoId.split('/').pop()}.json`;
  return {
    name: ref.name,
    suggested: ref.suggested,
    sizeGb: collectionSize(ref.sizeGb, components),
    labels: ref.labels,
    manifestUrl: `https://huggingface.co/${ref.repoId}/blob/main/${manifestFile}`,
    components,
  };
}
