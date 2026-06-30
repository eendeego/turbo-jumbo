import type {Model} from '@/lib/models';
import type {ModelRow, QuantInfo} from './models-table-client';

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
  const coldQuantKeys = new Set<string>();
  for (const m of coldModels) {
    for (const f of m.files) coldQuantKeys.add(`${m.name}::${f.quant}`);
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

  // Cold-storage paths for every quant present there, so cold-tab deletions use
  // the cold-storage-relative paths (not the local ones).
  const coldPathsMap = new Map<string, string[]>();
  for (const m of coldModels) {
    for (const f of m.files) {
      const key = `${m.name}::${f.quant}`;
      coldPathsMap.set(key, f.isSplit ? f.files.map((s) => s.path) : [f.path]);
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
        quantMap.set(f.quant, {
          label: f.quant,
          isSingleFile: !f.isSplit,
          filename: f.isSplit ? null : f.filename,
          displayName:
            localDisplayNames.get(quantKey) ??
            (f.isSplit ? f.representativeFilename : f.filename),
          inColdStorage: coldQuantKeys.has(quantKey),
          size: f.isSplit ? f.totalSize : f.size,
          paths:
            localPathsMap.get(quantKey) ?? coldPathsMap.get(quantKey) ?? [],
          coldPaths: coldPathsMap.get(quantKey) ?? [],
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
        allInColdStorage: quants.every((q) => q.inColdStorage),
        noneInColdStorage: quants.every((q) => !q.inColdStorage),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
