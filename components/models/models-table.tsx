'use client';

import {Table, proportional, type TableColumn} from '@astryxdesign/core/Table';
import type {Model} from '@/lib/models';

interface ModelRow extends Record<string, unknown> {
  name: string;
}

const columns: TableColumn<ModelRow>[] = [
  {key: 'name', header: 'Model', width: proportional(1)},
];

// A flat, de-duplicated list of every model name known across local storage and
// cold storage, sorted alphabetically.
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

  return <Table data={models} columns={columns} idKey="name" />;
}
