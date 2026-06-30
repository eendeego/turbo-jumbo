import type {Model} from '@/lib/models';
import {ModelsTableClient, type ModelRow} from './models-table-client';

// A flat, de-duplicated list of every model name known across local storage and
// cold storage, sorted alphabetically. Data prep runs on the server; the actual
// table (with its renderCell columns) renders in ModelsTableClient.
export function ModelsTable({
  coldModels,
  localModels,
}: {
  coldModels: Model[];
  localModels: Model[];
}) {
  const seen = new Set<string>();
  const models: ModelRow[] = [];
  for (const m of [...localModels, ...coldModels]) {
    if (!seen.has(m.name)) {
      seen.add(m.name);
      models.push({name: m.name});
    }
  }
  models.sort((a, b) => a.name.localeCompare(b.name));

  return <ModelsTableClient models={models} />;
}
