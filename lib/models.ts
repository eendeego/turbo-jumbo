import fs from 'fs';
import path from 'path';
import type {
  Model,
  ModelFile,
  Shard,
  SingleFile,
  SplitGroup,
} from '@/lib/model-types';
import {metaPath, pathImpliedRepo} from '@/lib/audit';
import {parseHubCachePath} from '@/lib/hf-cache';
import {readSafetensorsDtype} from '@/lib/safetensors';
import {isMmprojFilename, repoIdFromModelUrl} from '@/lib/model-name';
import {WEIGHT_EXT_RE, isWeightFile} from '@/lib/weight-files';

// Re-exported so existing `@/lib/models` importers keep working.
export {isWeightFile};

export type {
  Model,
  ModelFile,
  Shard,
  SingleFile,
  SplitGroup,
} from '@/lib/model-types';
export {shardPath, shardSize} from '@/lib/model-types';

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
 * The variant label for a weight file. A filename quant token wins (GGUF, or a
 * dtype-tagged safetensors). Otherwise a generic safetensors file is labeled by
 * its header dtype (BF16/F16/…), a `.bin` by a generic tag, and a tokenless
 * GGUF keeps `unknown`. `fullPath` is only read for tokenless safetensors.
 */
function weightLabel(
  fullPath: string,
  filename: string,
  quant: string,
): string {
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

export function scanModels(storagePath: string | undefined): Model[] {
  if (!storagePath) return [];
  const root = storagePath;
  const singleMap = new Map<string, SingleFile[]>();

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
        walk(path.join(dir, entry.name));
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);
      // In the hub cache layout the repo is encoded in the directory, so it's
      // the authoritative name regardless of the (often generic) filename.
      const cacheRepoId = parseHubCachePath(relPath)?.repoId ?? null;
      // Flat-layout safetensors/bin weights have generic filenames
      // (model.safetensors), so derive their repo from the `<org>/<repo>/`
      // directory the flat mirror stores them under. GGUF filenames carry the
      // model name, so they keep their filename-derived name.
      const flatRepoId = /\.(safetensors|bin)$/i.test(entry.name)
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
          sidecarRepoId(fullPath) ??
          flatRepoId ??
          extractModelName(`${base}.gguf`);
        const quant = extractQuant(`${base}.gguf`);
        const key = `${modelName}::${base}`;

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
          sidecarRepoId(fullPath) ??
          flatRepoId ??
          extractModelName(entry.name);
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
    .map(([name, files]) => ({
      name,
      files: files.sort((a, b) => a.quant.localeCompare(b.quant)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Basenames carried by more than one file in a scan: basename → every relative
 * path bearing it, keeping only names with 2+ paths. Split groups contribute
 * each shard's own filename. The audit flags these as duplicates — same-named
 * files in different directories within one storage location.
 */
export function duplicateBasenames(models: Model[]): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  const add = (relPath: string) => {
    // A cache-layout file is uniquely placed by its repo's snapshot; it is
    // never a stray basename duplicate the way a flat-layout copy can be.
    if (parseHubCachePath(relPath)) return;
    const name = path.basename(relPath);
    // mmproj projector files carry generic names (mmproj-F16.gguf) that recur
    // across vision models; same-named copies in different repos aren't
    // duplicates of each other, so never flag them.
    if (isMmprojFilename(name)) return;
    const paths = byName.get(name);
    if (paths) paths.push(relPath);
    else byName.set(name, [relPath]);
  };
  for (const model of models) {
    for (const file of model.files) {
      if (file.isSplit) for (const shard of file.files) add(shard.path);
      else add(file.path);
    }
  }
  return new Map([...byName].filter(([, paths]) => paths.length > 1));
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
