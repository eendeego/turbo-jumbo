// Download/cache status for Lemonade catalog entries: judging, from the local
// weight scans across locations, whether a model / omni component / collection
// is present and complete — and whether it sits in Lemonade's own cache.

import type {Model, ModelFile} from '@/lib/model-types';
import {isWeightFile} from '@/lib/weight-files';
import type {
  Checkpoint,
  DownloadStatus,
  InventoryLocation,
  LemonadeComponent,
  LemonadeDownloadInfo,
  LemonadeModel,
  OmniCollection,
} from '@/lib/lemonade-types';
import {FILENAME_VARIANT_RE, baseName} from '@/lib/lemonade-plan';

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
