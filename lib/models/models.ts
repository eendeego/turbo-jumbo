import fs from 'fs';
import path from 'path';
import type {
  Model,
  ModelFile,
  Shard,
  SingleFile,
  SplitGroup,
} from '@/lib/models/model-types';
import {metaPath, pathImpliedRepo} from '@/lib/audit/audit';
import {parseHubCachePath} from '@/lib/hf/hf-cache';
import {readSafetensorsDtype} from '@/lib/models/safetensors';
import {isMmprojFilename, repoIdFromModelUrl} from '@/lib/models/model-name';
import {isDiffusersComponentFile} from '@/lib/models/diffusers';
import {MODEL_SIDECAR_NAME, summarizeModel} from '@/lib/models/model-sidecar';
import type {
  SidecarSummary,
  TjModel,
  TjModelFile,
} from '@/lib/models/model-sidecar';
import {
  WEIGHT_EXT_RE,
  ggmlModelVariant,
  isWeightFile,
} from '@/lib/models/weight-files';

// Re-exported so existing `@/lib/models` importers keep working.
export {isWeightFile};

export type {
  Model,
  ModelFile,
  Shard,
  SingleFile,
  SplitGroup,
} from '@/lib/models/model-types';
export {shardPath, shardSize} from '@/lib/models/model-types';

/**
 * The model identity recorded in a file's `.tjmeta.json` sidecar, if any: the
 * `org/repo` the file was downloaded from / verified against. Read synchronously
 * to fit the synchronous scan. Returns null when the sidecar is absent or its
 * `modelUrl` is missing/unparseable, so the caller falls back to the
 * filename-derived name.
 */
function sidecarRepoId(fullPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath(fullPath), 'utf8');
  } catch {
    return null;
  }
  try {
    const meta = JSON.parse(raw) as {modelUrl?: unknown};
    return typeof meta.modelUrl === 'string'
      ? repoIdFromModelUrl(meta.modelUrl)
      : null;
  } catch {
    return null;
  }
}

/**
 * The model sidecar (`tjmodel.json`) that owns `fullPath`, found by walking up
 * from the file's directory to the nearest ancestor holding one (bounded by
 * `storagePath`). Read synchronously to fit the sync scan. Returns null when
 * none is found or the JSON is unparseable.
 */
function readSidecarFor(fullPath: string, storagePath: string): TjModel | null {
  let dir = path.dirname(fullPath);
  const root = path.resolve(storagePath);
  for (;;) {
    try {
      const raw = fs.readFileSync(path.join(dir, MODEL_SIDECAR_NAME), 'utf8');
      return JSON.parse(raw) as TjModel;
    } catch {
      // no (readable) sidecar here; keep walking up
    }
    if (path.resolve(dir) === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The repoId recorded in the model sidecar that owns `fullPath`, or null. The
 * authoritative name for the whole model dir.
 */
function modelSidecarRepoId(
  fullPath: string,
  storagePath: string,
): string | null {
  const m = readSidecarFor(fullPath, storagePath);
  return m && typeof m.repoId === 'string' ? m.repoId : null;
}

/** The model-level summary of the sidecar owning `fullPath`, or null. */
function modelSidecarSummary(
  fullPath: string,
  storagePath: string,
): SidecarSummary | null {
  const m = readSidecarFor(fullPath, storagePath);
  return m && typeof m.repoId === 'string' ? summarizeModel(m) : null;
}

/** The per-file records of the sidecar owning `fullPath`, or null. */
function modelSidecarFiles(
  fullPath: string,
  storagePath: string,
): TjModelFile[] | null {
  const m = readSidecarFor(fullPath, storagePath);
  return m && Array.isArray(m.files) ? m.files : null;
}

// A quantization token: IQ2_XS, Q4_K_M, MXFP4 (Microscaling FP4), BF16, F16, …
const QUANT_TOKEN =
  '(?:UD-)?(?:IQ\\d+_(?:XXS|XS|NL|[SML])|Q\\d+(?:_K(?:_(?:XL|XS|[SML]))?|_[01])?|MXFP4|BF16|F16|F32)';

// Match a quant token delimited by - _ . and followed by another delimiter or
// end of name. Global so callers take the LAST occurrence: the quant is usually
// the final token, but may be followed by descriptor suffixes — e.g.
// "GPT-OSS-20B-…-MXFP4-Aggressive" carries the quant before "-Aggressive".
const QUANT_RE = new RegExp(`[-_.](${QUANT_TOKEN})(?=[-_.]|$)`, 'gi');
const SPLIT_RE = /^(.+)-(\d+)-of-(\d+)\.(gguf|safetensors|bin)$/i;

function stripExtension(filename: string): string {
  return filename.replace(WEIGHT_EXT_RE, '');
}

function lastQuantMatch(base: string): RegExpMatchArray | null {
  const matches = [...base.matchAll(QUANT_RE)];
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

export function extractModelName(filename: string): string {
  const base = stripExtension(filename);
  const m = lastQuantMatch(base);
  if (m?.index == null) return base;
  // Remove the matched token along with its leading delimiter, leaving any
  // descriptor suffix (and its own delimiter) intact.
  return base.slice(0, m.index) + base.slice(m.index + m[0].length);
}

export function extractQuant(filename: string): string {
  const m = lastQuantMatch(stripExtension(filename));
  return m ? m[1].toUpperCase() : 'unknown';
}

/**
 * The variant label for a weight file. A whisper.cpp `ggml-*.bin` is labeled by
 * the model in its filename (tiny, large-v3-turbo, …): one repo ships several
 * standalone models with no quant token, so each is its own variant — like a
 * GGUF quant — rather than collapsing under a generic `pytorch` tag. Otherwise a
 * filename quant token wins (GGUF, or a dtype-tagged safetensors); a generic
 * safetensors file is labeled by its header dtype (BF16/F16/…), a `.bin` by a
 * generic tag, and a tokenless GGUF keeps `unknown`. `fullPath` is only read for
 * tokenless safetensors.
 */
function weightLabel(
  fullPath: string,
  filename: string,
  quant: string,
): string {
  const ggmlVariant = ggmlModelVariant(filename);
  if (ggmlVariant) return ggmlVariant;
  if (quant !== 'unknown') return quant;
  if (/\.safetensors$/i.test(filename)) {
    return readSafetensorsDtype(fullPath) ?? 'safetensors';
  }
  if (/\.bin$/i.test(filename)) return 'pytorch';
  return quant;
}

/**
 * Rewrite filename-derived model names to the repo name when a sidecar-named
 * copy of the same files exists in any of the given scans, then merge models
 * that end up sharing a name within a scan. A model's name depends on sidecar
 * presence (`sidecarRepoId` falls back to the filename), so the same model can
 * be named `gpt-oss-20b` by one scan and `unsloth/gpt-oss-20b-GGUF` by another
 * — e.g. when only the local copy has been audited — and would otherwise
 * produce two table rows. A name claimed by more than one repo is left alone:
 * there's no way to tell which repo the sidecar-less files belong to.
 */
export function normalizeModelNames(scans: Model[][]): Model[][] {
  // What a file group would be called with no sidecar present.
  const filenameAlias = (f: ModelFile): string => {
    const filename = f.isSplit ? f.representativeFilename : f.filename;
    const split = filename.match(SPLIT_RE);
    return extractModelName(split ? `${split[1]}.gguf` : filename);
  };

  // Filename-derived alias -> the repo names whose files claim it.
  const aliasRepos = new Map<string, Set<string>>();
  for (const models of scans) {
    for (const m of models) {
      if (!m.name.includes('/')) continue;
      for (const f of m.files) {
        const alias = filenameAlias(f);
        const repos = aliasRepos.get(alias);
        if (repos) {
          repos.add(m.name);
        } else {
          aliasRepos.set(alias, new Set([m.name]));
        }
      }
    }
  }

  return scans.map((models) => {
    const out = new Map<string, Model>();
    for (const m of models) {
      const repos = m.name.includes('/') ? null : aliasRepos.get(m.name);
      const name = repos?.size === 1 ? [...repos][0] : m.name;
      const existing = out.get(name);
      if (existing) {
        existing.files = [...existing.files, ...m.files];
      } else {
        out.set(name, {...m, name});
      }
    }
    return [...out.values()];
  });
}

export function scanModels(
  storagePath: string | undefined,
  lemonadePath?: string,
): Model[] {
  if (!storagePath) return [];
  const root = storagePath;
  // Lemonade keeps its own model cache; when it lives inside storagePath, skip
  // the directory (matched by name) so its copies don't show up as local models.
  const lemonadeDir = lemonadePath ? path.basename(lemonadePath) : null;
  const singleMap = new Map<string, SingleFile[]>();

  // One representative file path per model name, to read the model's sidecar
  // once after the walk (all of a model's files share its sidecar dir).
  const sampleByModel = new Map<string, string>();

  interface SplitAccum {
    modelName: string;
    quant: string;
    totalShards: number;
    presentIndices: Set<number>;
    presentPaths: Shard[];
    totalSize: number;
    representativeFilename: string;
  }
  const splitMap = new Map<string, SplitAccum>();

  function walk(dir: string) {
    let entries;
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (lemonadeDir && entry.name === lemonadeDir) continue;
        walk(path.join(dir, entry.name));
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);
      // In the hub cache layout the repo is encoded in the directory, so it's
      // the authoritative name regardless of the (often generic) filename.
      const cacheRepoId = parseHubCachePath(relPath)?.repoId ?? null;
      // A weight file stored under an `<org>/<repo>/` directory (the flat mirror
      // layout) takes that repo as its name when no sidecar says otherwise — the
      // directory is authoritative even for a GGUF whose filename carries the
      // model name. Otherwise the same file is named `gemma-3-4b-it` on a host
      // without a sidecar but `ggml-org/gemma-3-4b-it-GGUF` on one with it, so
      // the two copies don't join (and the peer tab shows the wrong name). A
      // truly loose file (no `<org>/<repo>/` path) still falls back to its
      // filename-derived name.
      const flatRepoId = isWeightFile(entry.name)
        ? (pathImpliedRepo(relPath)?.repoId ?? null)
        : null;
      const splitMatch = entry.name.match(SPLIT_RE);

      if (splitMatch) {
        const base = splitMatch[1];
        const index = parseInt(splitMatch[2], 10);
        const total = parseInt(splitMatch[3], 10);
        // Prefer the authoritative org/repo from the sidecar; fall back to the
        // filename-derived name when there's no sidecar.
        const modelName =
          cacheRepoId ??
          modelSidecarRepoId(fullPath, root) ??
          sidecarRepoId(fullPath) ??
          flatRepoId ??
          extractModelName(`${base}.gguf`);
        const quant = extractQuant(`${base}.gguf`);
        const key = `${modelName}::${base}`;
        if (!sampleByModel.has(modelName))
          sampleByModel.set(modelName, fullPath);

        let size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          /* inaccessible shard */
        }

        if (!splitMap.has(key)) {
          splitMap.set(key, {
            modelName,
            quant: weightLabel(fullPath, entry.name, quant),
            totalShards: total,
            presentIndices: new Set(),
            presentPaths: [],
            totalSize: 0,
            representativeFilename: entry.name,
          });
        }
        const accum = splitMap.get(key)!;
        accum.presentIndices.add(index);
        accum.presentPaths.push({path: relPath, size});
        accum.totalSize += size;
      } else if (isWeightFile(entry.name)) {
        let size = 0;
        let missing = false;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          missing = true;
        }
        const modelName =
          cacheRepoId ??
          modelSidecarRepoId(fullPath, root) ??
          sidecarRepoId(fullPath) ??
          flatRepoId ??
          extractModelName(entry.name);
        if (!sampleByModel.has(modelName))
          sampleByModel.set(modelName, fullPath);
        const file: SingleFile = {
          isSplit: false,
          filename: entry.name,
          path: relPath,
          quant: weightLabel(fullPath, entry.name, extractQuant(entry.name)),
          size,
          missing,
        };
        const existing = singleMap.get(modelName);
        if (existing) {
          existing.push(file);
        } else {
          singleMap.set(modelName, [file]);
        }
      }
    }
  }

  walk(storagePath);

  const modelMap = new Map<string, ModelFile[]>();

  for (const [modelName, files] of singleMap) {
    modelMap.set(modelName, [...files]);
  }

  for (const accum of splitMap.values()) {
    const missingIndices: number[] = [];
    for (let i = 1; i <= accum.totalShards; i++) {
      if (!accum.presentIndices.has(i)) missingIndices.push(i);
    }
    const splitGroup: SplitGroup = {
      isSplit: true,
      representativeFilename: accum.representativeFilename,
      files: accum.presentPaths,
      quant: accum.quant,
      totalShards: accum.totalShards,
      presentShards: accum.presentIndices.size,
      missingIndices,
      totalSize: accum.totalSize,
    };
    const existing = modelMap.get(accum.modelName);
    if (existing) {
      existing.push(splitGroup);
    } else {
      modelMap.set(accum.modelName, [splitGroup]);
    }
  }

  return Array.from(modelMap.entries())
    .map(([name, files]) => {
      const sample = sampleByModel.get(name);
      const sidecar = sample ? modelSidecarSummary(sample, storagePath) : null;
      const sidecarFiles = sample
        ? modelSidecarFiles(sample, storagePath)
        : null;
      return {
        name,
        files: files.sort((a, b) => a.quant.localeCompare(b.quant)),
        ...(sidecar ? {sidecar} : {}),
        ...(sidecarFiles ? {sidecarFiles} : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Basenames carried by more than one file in a scan: basename → every relative
 * path bearing it, keeping only names with 2+ paths. Split groups contribute
 * each shard's own filename. The audit flags these as duplicates — same-named
 * files in different directories within one storage location.
 *
 * A shared basename alone isn't enough: two builds of the same quant from
 * different repos (e.g. `unsloth/…` and `LiquidAI/…` both shipping
 * `LFM2-1.2B-Q4_K_M.gguf`) are different files that merely share a name. The
 * sidecar-recorded `sourceSha256` is a file's identity, so two copies whose
 * hashes are both known and differ are never duplicates of each other. An
 * unknown hash can't disprove a match, so it still pairs with anything — a
 * sidecar-less stray copy is still flagged against its twin, as before.
 */
export function duplicateBasenames(models: Model[]): Map<string, string[]> {
  const byName = new Map<string, Array<{path: string; sha: string}>>();
  const add = (relPath: string, sha: string) => {
    // A cache-layout file is uniquely placed by its repo's snapshot; it is
    // never a stray basename duplicate the way a flat-layout copy can be.
    if (parseHubCachePath(relPath)) return;
    // A diffusers component weight (`unet/…`, `vae/…`) carries a generic basename
    // (`diffusion_pytorch_model.safetensors`) shared across components — its
    // folder, not its name, identifies it, so it's never a basename duplicate.
    if (isDiffusersComponentFile(relPath)) return;
    const name = path.basename(relPath);
    // mmproj projector files carry generic names (mmproj-F16.gguf) that recur
    // across vision models; same-named copies in different repos aren't
    // duplicates of each other, so never flag them.
    if (isMmprojFilename(name)) return;
    const entries = byName.get(name);
    if (entries) entries.push({path: relPath, sha});
    else byName.set(name, [{path: relPath, sha}]);
  };
  for (const model of models) {
    // The model's recorded source hash per file basename, from its sidecar.
    const shaByBase = new Map<string, string>();
    for (const rec of model.sidecarFiles ?? [])
      shaByBase.set(path.basename(rec.path), rec.sourceSha256 ?? '');
    for (const file of model.files) {
      if (file.isSplit)
        for (const shard of file.files)
          add(shard.path, shaByBase.get(path.basename(shard.path)) ?? '');
      else add(file.path, shaByBase.get(path.basename(file.path)) ?? '');
    }
  }
  // Two copies are duplicates unless both hashes are known and differ; keep a
  // path only when some other same-named copy is a possible match.
  const compatible = (a: string, b: string) => !a || !b || a === b;
  const out = new Map<string, string[]>();
  for (const [name, entries] of byName) {
    if (entries.length < 2) continue;
    const dupPaths = entries
      .filter((e) => entries.some((o) => o !== e && compatible(e.sha, o.sha)))
      .map((e) => e.path);
    if (dupPaths.length > 1) out.set(name, dupPaths);
  }
  return out;
}

// Flag each file that has no matching copy in cold storage, so the UI can warn
// that it isn't backed up. A split group counts as present if any shard is.
export function annotateColdStorage(
  models: Model[],
  coldPath: string,
): Model[] {
  const coldBase = path.resolve(coldPath);
  const existsInCold = (rel: string): boolean => {
    try {
      fs.statSync(path.join(coldBase, rel));
      return true;
    } catch {
      return false;
    }
  };
  return models.map((model) => ({
    ...model,
    files: model.files.map((file): ModelFile => {
      if (file.isSplit) {
        const inCold = file.files.some((shard) => existsInCold(shard.path));
        return {...file, notInColdStorage: !inCold};
      }
      return {...file, notInColdStorage: !existsInCold(file.path)};
    }),
  }));
}
