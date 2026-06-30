import type {Model} from '@/lib/models';
import {ModelsTableClient, type ModelRow} from './models-table-client';

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
  const quantsByModel = new Map<string, Set<string>>();
  for (const m of [...localModels, ...coldModels]) {
    let quants = quantsByModel.get(m.name);
    if (!quants) {
      quants = new Set();
      quantsByModel.set(m.name, quants);
    }
    for (const f of m.files) quants.add(f.quant);
  }

  const models: ModelRow[] = [...quantsByModel.entries()]
    .map(([name, quants]) => {
      // Deduplicated bit sizes for the collapsed summary…
      const bits = [...new Set([...quants].map(quantBits))].sort(
        (a, b) => Number(a) - Number(b),
      );
      // …and the full quant list for the expanded child rows.
      const quantList = [...quants].sort((a, b) => a.localeCompare(b));
      return {name, quantizations: bits.join(', '), quants: quantList};
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return <ModelsTableClient models={models} />;
}
