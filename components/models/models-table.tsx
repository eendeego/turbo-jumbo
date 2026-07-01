import type {Model, ModelFile} from '@/lib/model-types';
import {modelDisplayName, isMmprojFilename} from '@/lib/model-name';
import {normalizeModelNames} from '@/lib/models';
import {fileJoinKey} from '@/lib/peer-paths';
import type {ModelRow, QuantInfo, ProjectorInfo} from './models-table-client';

// Extract the bit size from a quantization string (e.g. "Q4_K_M" → "4",
// "BF16" → "16"); falls back to the raw token when there's no number.
function quantBits(quant: string): string {
  const m = quant.match(/\d+/);
  return m ? m[0] : quant;
}

// Build one table row per model (across local + cold storage), each carrying
// its distinct quantizations and cold-storage presence flags. Pure data prep
// that runs on the server; the table renders in ModelsTableClient.
export function getModelsTableData(
  localModels: Model[],
  coldModels: Model[],
): ModelRow[] {
  return buildModelRows(localModels, coldModels);
}

export function buildModelRows(
  localScan: Model[],
  coldScan: Model[],
): ModelRow[] {
  // A model's name depends on which copies carry sidecars, so the two scans
  // can name the same model differently; reconcile before grouping by name
  // (see normalizeModelNames).
  const [localNorm, coldNorm] = normalizeModelNames([localScan, coldScan]);

  // mmproj projector files are not quantizations — pull them out before quant
  // assembly so they never become a QuantInfo (or collide with a real
  // same-label weight), and surface them per model for the hovercard.
  const projectorsByModel = new Map<string, ProjectorInfo[]>();
  const addProjector = (modelName: string, filename: string, size: number) => {
    const list = projectorsByModel.get(modelName) ?? [];
    if (!list.some((p) => p.filename === filename)) list.push({filename, size});
    projectorsByModel.set(modelName, list);
  };
  const stripProjectors = (models: Model[]): Model[] =>
    models.map((m) => {
      const files: ModelFile[] = [];
      for (const f of m.files) {
        const base = f.isSplit ? f.representativeFilename : f.filename;
        if (isMmprojFilename(base)) {
          addProjector(m.name, base, f.isSplit ? f.totalSize : f.size);
        } else {
          files.push(f);
        }
      }
      return {...m, files};
    });
  const localModels = stripProjectors(localNorm);
  const coldModels = stripProjectors(coldNorm);

  // Index cold files by join key. This is what survives the differences between
  // the two roots: the same file can sit at a bare path in one and under
  // <repoId>/ in the other, and the model name is sidecar-derived (so it differs
  // too). Neither the path nor the name can join them — but filename + size can,
  // and size also tells apart same-named files from different repos (e.g. an MTP
  // vs non-MTP build).
  // Files are joined by `fileJoinKey`: a specific basename (GGUF) on its own —
  // surviving the layout and per-host name differences — and a generic weight
  // name (model.safetensors) qualified by the repo-derived model name, so a
  // different repo's same-named file isn't mistaken for a cold copy.
  const fileBase = (relPath: string) => relPath.split('/').pop() ?? relPath;
  const coldByKey = new Map<string, Array<{size: number; path: string}>>();
  const addCold = (key: string, size: number, p: string) => {
    const list = coldByKey.get(key);
    if (list) list.push({size, path: p});
    else coldByKey.set(key, [{size, path: p}]);
  };
  for (const m of coldModels) {
    for (const f of m.files) {
      if (f.isSplit) {
        for (const s of f.files)
          addCold(fileJoinKey(m.name, fileBase(s.path)), s.size, s.path);
      } else {
        addCold(fileJoinKey(m.name, f.filename), f.size, f.path);
      }
    }
  }

  // The cold copy of a local file: prefer a size-exact match (a complete,
  // identical copy), else any file of the same key (a partial/mismatched copy).
  // null when none exists.
  const coldMatch = (key: string, size: number) => {
    const candidates = coldByKey.get(key);
    if (!candidates || candidates.length === 0) return null;
    return candidates.find((c) => c.size === size) ?? candidates[0];
  };

  // Total size of each quant's cold copy (split groups summed), for comparing
  // against peer copies of the same quant.
  const coldQuantSizes = new Map<string, number>();
  for (const m of coldModels) {
    for (const f of m.files) {
      coldQuantSizes.set(
        `${m.name}::${f.quant}`,
        f.isSplit ? f.totalSize : f.size,
      );
    }
  }

  // Local file paths + display name per model::quant, for selection/deletion.
  const localPathsMap = new Map<string, string[]>();
  const localDisplayNames = new Map<string, string>();
  for (const m of localModels) {
    for (const f of m.files) {
      const key = `${m.name}::${f.quant}`;
      if (f.isSplit) {
        localPathsMap.set(
          key,
          f.files.map((s) => s.path),
        );
        localDisplayNames.set(key, f.representativeFilename);
      } else {
        localPathsMap.set(key, [f.path]);
        localDisplayNames.set(key, f.filename);
      }
    }
  }

  const rowMap = new Map<string, Map<string, QuantInfo>>();
  for (const m of [...localModels, ...coldModels]) {
    let quantMap = rowMap.get(m.name);
    if (!quantMap) {
      quantMap = new Map();
      rowMap.set(m.name, quantMap);
    }
    for (const f of m.files) {
      if (!quantMap.has(f.quant)) {
        const quantKey = `${m.name}::${f.quant}`;
        // Match each file to its cold copy by filename; size then decides
        // whether that copy is complete (identical) or just shares the name
        // (a partial/incomplete copy, or a different repo's same-named build).
        const localFiles = f.isSplit
          ? f.files.map((s) => ({base: fileBase(s.path), size: s.size}))
          : [{base: f.filename, size: f.size}];
        const coldHits = localFiles.map((lf) =>
          coldMatch(fileJoinKey(m.name, lf.base), lf.size),
        );
        const present = coldHits.filter(
          (c): c is {size: number; path: string} => c != null,
        );
        const inColdStorage = present.length > 0;
        const coldComplete =
          inColdStorage &&
          localFiles.every((lf, i) => coldHits[i]?.size === lf.size);
        const coldPaths = present.map((c) => c.path);
        const relPaths = f.isSplit ? f.files.map((s) => s.path) : [f.path];
        // A cold size to flag, only for single-file quants where a size mismatch
        // means an incomplete/partial cold copy.
        const coldSize =
          !f.isSplit && present.length === 1 ? present[0].size : null;
        quantMap.set(f.quant, {
          label: f.quant,
          isSingleFile: !f.isSplit,
          filename: f.isSplit ? null : f.filename,
          displayName:
            localDisplayNames.get(quantKey) ??
            (f.isSplit ? f.representativeFilename : f.filename),
          inColdStorage,
          coldComplete,
          coldSize,
          coldTotalSize: coldQuantSizes.get(quantKey) ?? 0,
          size: f.isSplit ? f.totalSize : f.size,
          paths: localPathsMap.get(quantKey) ?? relPaths,
          coldPaths,
          shards: f.isSplit
            ? [...f.files]
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((s) => ({
                  filename: s.path.split('/').pop() ?? s.path,
                  size: s.size,
                }))
            : [],
          totalShards: f.isSplit ? f.totalShards : 0,
          presentShards: f.isSplit ? f.presentShards : 0,
          missingIndices: f.isSplit ? f.missingIndices : [],
        });
      }
    }
  }

  return [...rowMap.entries()]
    .map(([name, quantMap]) => {
      const quants = [...quantMap.values()].sort(
        (a, b) => Number(quantBits(a.label)) - Number(quantBits(b.label)),
      );
      const bits = [...new Set(quants.map((q) => quantBits(q.label)))];
      const sizes = quants.map((q) => q.size).filter((s) => s > 0);
      return {
        name,
        quantizations: bits.join(', '),
        quants,
        minSize: sizes.length > 0 ? Math.min(...sizes) : 0,
        maxSize: sizes.length > 0 ? Math.max(...sizes) : 0,
        // "Complete" only when every quant has an identical (size-matching) cold
        // copy; an incomplete copy counts as present but not complete.
        allInColdStorage: quants.every((q) => q.coldComplete),
        noneInColdStorage: quants.every((q) => !q.inColdStorage),
        projectors: projectorsByModel.get(name) ?? [],
      };
    })
    .sort((a, b) =>
      modelDisplayName(a.name).localeCompare(
        modelDisplayName(b.name),
        undefined,
        {
          sensitivity: 'base',
        },
      ),
    );
}
