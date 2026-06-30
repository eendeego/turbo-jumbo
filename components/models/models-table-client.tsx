'use client';

import {useState, useCallback} from 'react';
import * as stylex from '@stylexjs/stylex';
import {Table, proportional, type TableColumn} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';

export interface ModelRow extends Record<string, unknown> {
  name: string;
  quantizations: string;
  quants: string[];
}

interface DisplayRow extends Record<string, unknown> {
  key: string;
  label: string;
  quantizations: string;
  isChild: boolean;
  parentName: string;
}

const styles = stylex.create({
  indent: {paddingInlineStart: '1.5rem'},
});

function NameCell({
  row,
  isExpanded,
  onToggle,
}: {
  row: DisplayRow;
  isExpanded: boolean;
  onToggle: (name: string) => void;
}) {
  if (row.isChild) {
    return (
      <Text type="body" color="secondary" xstyle={styles.indent}>
        {row.label}
      </Text>
    );
  }
  return (
    <Button
      label={row.label}
      variant="ghost"
      size="sm"
      icon={<Icon icon={isExpanded ? 'chevronDown' : 'chevronRight'} />}
      onClick={() => onToggle(row.parentName)}
    />
  );
}

export function ModelsTableClient({models}: {models: ModelRow[]}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const rows: DisplayRow[] = [];
  for (const m of models) {
    rows.push({
      key: m.name,
      label: m.name,
      quantizations: m.quantizations,
      isChild: false,
      parentName: m.name,
    });
    if (expanded.has(m.name)) {
      for (const q of m.quants) {
        rows.push({
          key: `${m.name}::${q}`,
          label: q,
          quantizations: '',
          isChild: true,
          parentName: m.name,
        });
      }
    }
  }

  const columns: TableColumn<DisplayRow>[] = [
    {
      key: 'label',
      header: 'Model',
      width: proportional(1),
      renderCell: (item) => (
        <NameCell
          row={item}
          isExpanded={expanded.has(item.parentName)}
          onToggle={toggle}
        />
      ),
    },
    {
      key: 'quantizations',
      header: 'Quantizations',
      width: proportional(1),
      renderCell: (item) =>
        item.isChild ? null : <Text type="body">{item.quantizations}</Text>,
    },
  ];

  return <Table data={rows} columns={columns} idKey="key" />;
}
