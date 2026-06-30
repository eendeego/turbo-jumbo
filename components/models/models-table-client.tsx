'use client';

import {Table, proportional, type TableColumn} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';

export interface ModelRow extends Record<string, unknown> {
  name: string;
  quantizations: string;
}

// Columns carry a renderCell function, which can't cross the server/client
// boundary — so they live in this client component while the server component
// (models-table.tsx) prepares the serializable row data.
const columns: TableColumn<ModelRow>[] = [
  {
    key: 'name',
    header: 'Model',
    width: proportional(1),
    renderCell: (item) => <Text type="body">{item.name}</Text>,
  },
  {
    key: 'quantizations',
    header: 'Quantizations',
    width: proportional(1),
    renderCell: (item) => <Text type="body">{item.quantizations}</Text>,
  },
];

export function ModelsTableClient({models}: {models: ModelRow[]}) {
  return <Table data={models} columns={columns} idKey="name" />;
}
