import type {Model} from '@/lib/models';
import {
  ModelsTableClient,
  type ModelRow,
  type QuantInfo,
} from './models-table-client';

// Extract the bit size from a quantization string (e.g. "Q4_K_M" → "4",
// "BF16" → "16"); falls back to the raw token when there's no number.
function quantBits(quant: string): string {
  const m = quant.match(/\d+/);
  return m ? m[0] : quant;
}

// One row per model (across local + cold storage), with the distinct
// quantization bit sizes it's available in. Data prep runs on the server; the
// table (with its renderCell columns) renders in ModelsTableClient.
export function ModelsTable({
  coldModels,
  localModels,
}: {
  coldModels: Model[];
  localModels: Model[];
}) {
  const quantsByModel = new Map<string, Map<string, QuantInfo>>();
  for (const m of [...localModels, ...coldModels]) {
    let quantMap = quantsByModel.get(m.name);
    if (!quantMap) {
      quantMap = new Map();
      quantsByModel.set(m.name, quantMap);
    }
    for (const f of m.files) {
      if (!quantMap.has(f.quant)) {
        quantMap.set(f.quant, {
          label: f.quant,
          isSingleFile: !f.isSplit,
          filename: f.isSplit ? null : f.filename,
        });
      }
    }
  }

  const models: ModelRow[] = [...quantsByModel.entries()]
    .map(([name, quantMap]) => {
      const quants = [...quantMap.values()].sort(
        (a, b) => Number(quantBits(a.label)) - Number(quantBits(b.label)),
      );
      const bits = [...new Set(quants.map((q) => quantBits(q.label)))];
      return {name, quantizations: bits.join(', '), quants};
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return <ModelsTableClient models={models} />;
}
