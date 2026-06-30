import fs from 'fs';
import path from 'path';
import type {Model, ModelFile, Shard, SingleFile, SplitGroup} from '@/lib/model-types';

export type {Model, ModelFile, Shard, SingleFile, SplitGroup} from '@/lib/model-types';
export {shardPath, shardSize} from '@/lib/model-types';

const QUANT_RE =
  /[-_.](?:UD-)?(?:IQ\d+_(?:XXS|XS|NL|[SML])|Q\d+(?:_K(?:_(?:XL|XS|[SML]))?|_[01])?|BF16|F16|F32)$/i;
const SPLIT_RE = /^(.+)-(\d+)-of-(\d+)\.gguf$/i;

function extractModelName(filename: string): string {
  return filename
    .replace(/\.(gguf|safetensors|bin)$/i, '')
    .replace(QUANT_RE, '');
}

function extractQuant(filename: string): string {
  const base = filename.replace(/\.(gguf|safetensors|bin)$/i, '');
  const m = base.match(
    /[-_.]((?:UD-)?(?:IQ\d+_(?:XXS|XS|NL|[SML])|Q\d+(?:_K(?:_(?:XL|XS|[SML]))?|_[01])?|BF16|F16|F32))$/i,
  );
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
