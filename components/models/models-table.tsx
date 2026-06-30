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
  const bitsByModel = new Map<string, Set<string>>();
  for (const m of [...localModels, ...coldModels]) {
    let bits = bitsByModel.get(m.name);
    if (!bits) {
      bits = new Set();
      bitsByModel.set(m.name, bits);
    }
    for (const f of m.files) bits.add(quantBits(f.quant));
  }

  const models: ModelRow[] = [...bitsByModel.entries()]
    .map(([name, bits]) => ({
      name,
      quantizations: [...bits].sort((a, b) => Number(a) - Number(b)).join(', '),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return <ModelsTableClient models={models} />;
}
