// Parsing for the Lemonade SDK model catalog (server_models.json): a map of
// model name -> {checkpoint, recipe, size, ...}. Only `llamacpp`-recipe
// entries matter here — they are single GGUF files in HF repos, which is what
// this app stores; other recipes (ONNX, whisper, SD) are multi-file layouts.

import type {Model, ModelFile} from '@/lib/model-types';
import {isWeightFile} from '@/lib/weight-files';

// The Lemonade SDK's model catalog, read from the repo's default branch head so
// the list tracks their latest release rather than a pinned revision.
export const LEMONADE_CATALOG_URL =
  'https://raw.githubusercontent.com/lemonade-sdk/lemonade/main/src/cpp/resources/server_models.json';

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

/** A repo + variant to fetch: one of a component's role checkpoints. */
export interface Checkpoint {
  repoId: string;
  variant: string | null; // quant token, exact filename, or null = whole repo
}

/**
 * One member of an omni collection. `downloadable` is true for `llamacpp` GGUF
 * members that join a `LemonadeModel` by `name`; image/audio/TTS members
 * (sd-cpp, whispercpp, kokoro, …) carry their display fields too, and every
 * member lists the `checkpoints` (repos/files) a full download fetches.
 */
export interface LemonadeComponent {
  name: string;
  recipe: string;
  modality: string; // display label: chat, vision, image, transcription, tts…
  sizeGb: number;
  downloadable: boolean;
  checkpoints: Checkpoint[]; // every repo/file this member pulls
}

/**
 * An omni model (`recipe: "collection.omni"`): a bundle of component models
 * rather than a single GGUF. Rendered as an expandable group; its downloadable
 * members reuse the normal per-model download path.
 */
export interface OmniCollection {
  name: string;
  suggested: boolean;
  sizeGb: number;
  labels: string[];
  components: LemonadeComponent[];
}

/**
 * A `collection.omni` entry whose components live in a manifest JSON inside an
 * HF repo (rather than inline in the catalog). The route fetches `{repo}.json`
 * and resolves it with `collectionFromManifest`.
 */
export interface OmniManifestRef {
  name: string;
  repoId: string;
  suggested: boolean;
  sizeGb: number;
  labels: string[];
}

export interface ParsedLemonade {
  models: LemonadeModel[]; // llamacpp GGUF models, as before
  // Every other standalone catalog entry (ONNX/vLLM LLMs, image, speech, TTS),
  // as components — they carry their own checkpoints and download like an omni
  // member, just not via the single-file GGUF path.
  extraModels: LemonadeComponent[];
  collections: OmniCollection[]; // inline omni collections, fully resolved
  manifestRefs: OmniManifestRef[]; // omni collections needing a manifest fetch
}

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

// Which section a catalog entry belongs to, for the modality-split catalog.
export type CatalogSection =
  | 'llm'
  | 'vision'
  | 'embeddings'
  | 'reranking'
  | 'image'
  | 'transcription'
  | 'tts'
  | 'onnx'
  | 'vllm'
  | 'other';

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
  ref: {name: string; suggested: boolean; sizeGb: number; labels: string[]},
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
  return {
    name: ref.name,
    suggested: ref.suggested,
    sizeGb: collectionSize(ref.sizeGb, components),
    labels: ref.labels,
    components,
  };
}

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

/** A per-repo download job: the repo and the variants to resolve within it. */
export interface RepoJob {
  repoId: string;
  variants: Array<string | null>;
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
const FILENAME_VARIANT_RE = /\.[A-Za-z0-9]+$/;
const baseName = (p: string) => p.split('/').pop() ?? p;

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

export type DownloadStatus = 'none' | 'partial' | 'complete';

/** One storage location's scan, labeled for display in the marker tooltip. */
export interface InventoryLocation {
  name: string; // "local", "cold storage", a peer name like "my-server"
  models: Model[];
  isLocal?: boolean; // the location downloads land in
}

/** Where a catalog entry is present, and how complete each copy is. */
export interface LemonadeDownloadInfo {
  status: DownloadStatus; // best across all locations
  locations: Array<{name: string; status: 'partial' | 'complete'}>;
}

// Strip a `-NNNNN-of-MMMMM` shard suffix that sits just before the extension,
// so a split group's representative filename can be compared to a Lemonade
// exact-filename variant (which names the unsharded file).
const SHARD_SUFFIX_RE = /-\d+-of-\d+(?=\.[^.]+$)/i;
const stripShard = (name: string) => name.replace(SHARD_SUFFIX_RE, '');

const groupFilename = (f: ModelFile) =>
  f.isSplit ? f.representativeFilename : f.filename;

// A weight group counts as present-and-whole when every shard is accounted for
// (single files are atomic; a failed stat marks them missing).
const groupComplete = (f: ModelFile): boolean =>
  f.isSplit
    ? f.totalShards > 0 && f.presentShards === f.totalShards
    : !f.missing;

// Does this scanned weight group satisfy the catalog entry's variant? Mirrors
// matchVariantFiles' selection rules, but over already-scanned ModelFiles
// (which carry a quant label and, for split groups, a representative name).
function fileMatchesVariant(f: ModelFile, variant: string | null): boolean {
  const base = (groupFilename(f).split('/').pop() ?? '').toLowerCase();
  if (!base.endsWith('.gguf')) return false;
  if (variant == null) return !base.startsWith('mmproj');
  if (variant.toLowerCase().endsWith('.gguf')) {
    const v = variant.toLowerCase();
    return base === v || stripShard(base) === stripShard(v);
  }
  if (base.startsWith('mmproj')) return false;
  const token = variant.toLowerCase();
  return f.quant.toLowerCase() === token || base.includes(token);
}

function locationStatus(model: LemonadeModel, models: Model[]): DownloadStatus {
  // The hub-cache scan names a model by its repo id, which is where Lemonade
  // downloads land — so the entry's repo id is the join key.
  const files = models
    .filter((m) => m.name === model.repoId)
    .flatMap((m) => m.files);
  const matched = files.filter((f) => fileMatchesVariant(f, model.variant));
  if (matched.length === 0) return 'none';
  let complete = matched.every(groupComplete);
  if (model.mmproj) {
    const want = model.mmproj.toLowerCase();
    const hasMmproj = files.some(
      (f) =>
        (groupFilename(f).split('/').pop() ?? '').toLowerCase() === want &&
        groupComplete(f),
    );
    if (!hasMmproj) complete = false;
  }
  return complete ? 'complete' : 'partial';
}

/**
 * Whether a Lemonade catalog entry is already downloaded, across the given
 * locations. Status is the best any single location offers (complete > partial
 * > none); `locations` lists every location that has a copy, in input order,
 * with that location's own completeness.
 */
export function lemonadeDownloadStatus(
  model: LemonadeModel,
  locations: InventoryLocation[],
): LemonadeDownloadInfo {
  const hits: Array<{name: string; status: 'partial' | 'complete'}> = [];
  for (const loc of locations) {
    const s = locationStatus(model, loc.models);
    if (s !== 'none') hits.push({name: loc.name, status: s});
  }
  const status: DownloadStatus = hits.some((h) => h.status === 'complete')
    ? 'complete'
    : hits.length > 0
      ? 'partial'
      : 'none';
  return {status, locations: hits};
}

/** Tooltip text for a marker: locations grouped by completeness. */
export function lemonadeStatusTooltip(info: LemonadeDownloadInfo): string {
  const names = (s: 'partial' | 'complete') =>
    info.locations.filter((l) => l.status === s).map((l) => l.name);
  const complete = names('complete');
  const partial = names('partial');
  const parts: string[] = [];
  if (complete.length) parts.push(`Complete: ${complete.join(', ')}.`);
  if (partial.length) parts.push(`Partial: ${partial.join(', ')}.`);
  return parts.join(' ');
}

// --- omni collection download status ------------------------------------

// `untracked` means the weight scan can't see this thing at all — a whole-repo
// (null) checkpoint or a non-weight file like a kokoro `.onnx` — so it's
// neither confirmable nor counted as missing.
type Presence = 'untracked' | 'none' | 'partial' | 'complete';

// One checkpoint's presence within a single location's scan.
function checkpointPresence(cp: Checkpoint, models: Model[]): Presence {
  const {variant} = cp;
  if (variant == null) {
    // A whole-repo checkpoint can't be matched file-by-file (the weight scan may
    // not classify all its files, e.g. a kokoro `.onnx`). Count the repo being
    // present — by id — as complete, mirroring the Lemonade-cache check
    // (checkpointInCache). Coarse: it can't confirm every file is there.
    return models.some((m) => m.name === cp.repoId) ? 'complete' : 'none';
  }
  const isFilename = FILENAME_VARIANT_RE.test(variant);
  if (isFilename && !isWeightFile(variant)) return 'untracked';
  const files = models
    .filter((m) => m.name === cp.repoId)
    .flatMap((m) => m.files);
  const matched = isFilename
    ? files.filter(
        (f) =>
          baseName(groupFilename(f)).toLowerCase() ===
          baseName(variant).toLowerCase(),
      )
    : files.filter((f) => fileMatchesVariant(f, variant));
  if (matched.length === 0) return 'none';
  return matched.every(groupComplete) ? 'complete' : 'partial';
}

// Roll several presences up: complete only when every tracked one is complete
// (and at least one is tracked); untracked when nothing could be tracked.
function rollUpPresence(values: Presence[]): Presence {
  let tracked = 0;
  let anyPresent = false;
  let allComplete = true;
  for (const v of values) {
    if (v === 'untracked') continue;
    tracked++;
    if (v !== 'none') anyPresent = true;
    if (v !== 'complete') allComplete = false;
  }
  if (tracked === 0) return 'untracked';
  if (allComplete) return 'complete';
  return anyPresent ? 'partial' : 'none';
}

function componentPresence(
  component: LemonadeComponent,
  models: Model[],
): Presence {
  return rollUpPresence(
    component.checkpoints.map((cp) => checkpointPresence(cp, models)),
  );
}

// Best presence across locations, as a LemonadeDownloadInfo. `untracked`/`none`
// in a location contribute no hit, so an all-untrackable thing reads as absent.
function presenceAcross(
  presence: (models: Model[]) => Presence,
  locations: InventoryLocation[],
): LemonadeDownloadInfo {
  const hits: Array<{name: string; status: 'partial' | 'complete'}> = [];
  for (const loc of locations) {
    const s = presence(loc.models);
    if (s === 'partial' || s === 'complete')
      hits.push({name: loc.name, status: s});
  }
  const status: DownloadStatus = hits.some((h) => h.status === 'complete')
    ? 'complete'
    : hits.length > 0
      ? 'partial'
      : 'none';
  return {status, locations: hits};
}

/**
 * An omni component's download status across locations (best wins), judged only
 * by the files the weight scan tracks. A component whose files aren't trackable
 * (a kokoro ONNX) reads as `none` rather than holding a collection back.
 */
export function componentDownloadStatus(
  component: LemonadeComponent,
  locations: InventoryLocation[],
): LemonadeDownloadInfo {
  return presenceAcross(
    (models) => componentPresence(component, models),
    locations,
  );
}

/**
 * An omni collection's download status: per location, complete only when every
 * trackable member is complete there — so a bundle whose pieces are split
 * across locations reads partial — with the best location winning overall.
 */
export function collectionDownloadStatus(
  collection: OmniCollection,
  locations: InventoryLocation[],
): LemonadeDownloadInfo {
  return presenceAcross(
    (models) =>
      rollUpPresence(
        collection.components.map((c) => componentPresence(c, models)),
      ),
    locations,
  );
}

// --- presence in Lemonade's own cache directory -------------------------

// Whether a single checkpoint is in the cache scan. Looser than
// checkpointPresence: the Lemonade cache is hub-cache-keyed by repo id and
// holds files the weight scan can't classify (a kokoro `.onnx`, a whole-repo
// null-variant checkpoint), so when the variant can't be matched file-by-file
// the repo id simply being present counts as cached. Trackable GGUF variants
// still match precisely, so one variant in the cache doesn't flag its siblings.
function checkpointInCache(cp: Checkpoint, cacheModels: Model[]): boolean {
  const presence = checkpointPresence(cp, cacheModels);
  if (presence === 'complete' || presence === 'partial') return true;
  if (presence === 'untracked')
    return cacheModels.some((m) => m.name === cp.repoId);
  return false; // 'none': the variant is trackable but genuinely absent.
}

/** Whether a Lemonade catalog model is present in the Lemonade cache scan. */
export function modelInLemonadeCache(
  model: LemonadeModel,
  cacheModels: Model[],
): boolean {
  return locationStatus(model, cacheModels) !== 'none';
}

/** Whether any of an omni component's checkpoints is in the Lemonade cache. */
export function componentInLemonadeCache(
  component: LemonadeComponent,
  cacheModels: Model[],
): boolean {
  return component.checkpoints.some((cp) => checkpointInCache(cp, cacheModels));
}

/** Whether any member of an omni collection is in the Lemonade cache. */
export function collectionInLemonadeCache(
  collection: OmniCollection,
  cacheModels: Model[],
): boolean {
  return collection.components.some((c) =>
    componentInLemonadeCache(c, cacheModels),
  );
}
