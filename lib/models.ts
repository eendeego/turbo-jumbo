import fs from 'fs';
import path from 'path';
import type {Model, ModelFile, Shard, SingleFile, SplitGroup} from '@/lib/model-types';

export type {Model, ModelFile, Shard, SingleFile, SplitGroup} from '@/lib/model-types';
export {shardPath, shardSize} from '@/lib/model-types';

// A quantization token: IQ2_XS, Q4_K_M, MXFP4 (Microscaling FP4), BF16, F16, …
const QUANT_TOKEN =
  '(?:UD-)?(?:IQ\\d+_(?:XXS|XS|NL|[SML])|Q\\d+(?:_K(?:_(?:XL|XS|[SML]))?|_[01])?|MXFP4|BF16|F16|F32)';

// Match a quant token delimited by - _ . and followed by another delimiter or
// end of name. Global so callers take the LAST occurrence: the quant is usually
// the final token, but may be followed by descriptor suffixes — e.g.
// "GPT-OSS-20B-…-MXFP4-Aggressive" carries the quant before "-Aggressive".
const QUANT_RE = new RegExp(`[-_.](${QUANT_TOKEN})(?=[-_.]|$)`, 'gi');
const SPLIT_RE = /^(.+)-(\d+)-of-(\d+)\.gguf$/i;

function stripExtension(filename: string): string {
  return filename.replace(/\.(gguf|safetensors|bin)$/i, '');
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
      const splitMatch = entry.name.match(SPLIT_RE);

      if (splitMatch) {
        const base = splitMatch[1];
        const index = parseInt(splitMatch[2], 10);
        const total = parseInt(splitMatch[3], 10);
        const modelName = extractModelName(`${base}.gguf`);
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
            quant,
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
      } else if (/\.(gguf|safetensors|bin)$/i.test(entry.name)) {
        let size = 0;
        let missing = false;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          missing = true;
        }
        const modelName = extractModelName(entry.name);
        const file: SingleFile = {
          isSplit: false,
          filename: entry.name,
          path: relPath,
          quant: extractQuant(entry.name),
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
