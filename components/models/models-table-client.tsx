'use client';

import {useState, useCallback} from 'react';
import * as stylex from '@stylexjs/stylex';
import {Table, proportional, type TableColumn} from '@astryxdesign/core/Table';
import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import type {Peer as PeerConfig} from '@/lib/config';
import type {PeerModels} from '@/components/peers/peer';

export interface QuantInfo {
  label: string;
  filename: string | null;
  isSingleFile: boolean;
  inColdStorage: boolean;
}

export interface ModelRow extends Record<string, unknown> {
  name: string;
  quantizations: string;
  quants: QuantInfo[];
  allInColdStorage: boolean;
  noneInColdStorage: boolean;
}

interface DisplayRow extends Record<string, unknown> {
  key: string;
  label: string;
  quantizations: string;
  isSingleFile: boolean;
  filename: string | null;
  isChild: boolean;
  parentName: string;
  inColdStorage: boolean | null;
  allInColdStorage: boolean;
  noneInColdStorage: boolean;
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
    if (row.isSingleFile) {
      return (
        <HStack gap={2} vAlign="center" xstyle={styles.indent}>
          <Text type="body">{row.label}</Text>
          <Text type="supporting">{row.filename}</Text>
        </HStack>
      );
    }
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
      tooltip={`Quantizations: ${row.quantizations}`}
      onClick={() => onToggle(row.parentName)}
    />
  );
}

function PeersCell({
  row,
  peers,
  peerQuantKeys,
  peerModelKeys,
}: {
  row: DisplayRow;
  peers: PeerConfig[];
  peerQuantKeys: Map<string, Set<string>>;
  peerModelKeys: Map<string, Set<string>>;
}) {
  if (peers.length === 0) return null;
  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
      {peers.map((peer) => {
        const quantKey = `${row.parentName}::${row.label}`;
        const hasPeer = row.isChild
          ? (peerQuantKeys.get(peer.address)?.has(quantKey) ?? false)
          : (peerModelKeys.get(peer.address)?.has(row.parentName) ?? false);
        return (
          <Badge
            key={peer.address}
            label={peer.name}
            variant={hasPeer ? (peer.isLocal ? 'blue' : 'cyan') : 'neutral'}
          />
        );
      })}
    </HStack>
  );
}

function ColdStorageCell({row}: {row: DisplayRow}) {
  if (row.isChild) {
    return row.inColdStorage ? (
      <Badge label="Yes" variant="green" />
    ) : (
      <Badge label="Missing" variant="red" />
    );
  }
  if (row.allInColdStorage) return <Badge label="Complete" variant="green" />;
  if (row.noneInColdStorage) return <Badge label="Missing" variant="red" />;
  return <Badge label="Partial" variant="orange" />;
}

export function ModelsTableClient({
  models,
  peers,
  peerModels,
}: {
  models: ModelRow[];
  peers: PeerConfig[];
  peerModels: Map<string, PeerModels>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // peerAddress -> Set<"modelName::quant"> and peerAddress -> Set<modelName>.
  const peerQuantKeys = new Map<string, Set<string>>();
  const peerModelKeys = new Map<string, Set<string>>();
  for (const [address, lo] of peerModels) {
    if (lo.type !== 'value') continue;
    const quantKeys = new Set<string>();
    const modelKeys = new Set<string>();
    for (const m of lo.value) {
      modelKeys.add(m.name);
      for (const f of m.files) quantKeys.add(`${m.name}::${f.quant}`);
    }
    peerQuantKeys.set(address, quantKeys);
    peerModelKeys.set(address, modelKeys);
  }

  const rows: DisplayRow[] = [];
  for (const m of models) {
    rows.push({
      key: m.name,
      label: m.name,
      quantizations: m.quantizations,
      isSingleFile: false,
      filename: null,
      isChild: false,
      parentName: m.name,
      inColdStorage: null,
      allInColdStorage: m.allInColdStorage,
      noneInColdStorage: m.noneInColdStorage,
    });
    if (expanded.has(m.name)) {
      for (const q of m.quants) {
        rows.push({
          key: `${m.name}::${q.label}`,
          label: q.label,
          quantizations: '',
          isSingleFile: q.isSingleFile,
          filename: q.filename,
          isChild: true,
          parentName: m.name,
          inColdStorage: q.inColdStorage,
          allInColdStorage: false,
          noneInColdStorage: false,
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
      key: 'peers',
      header: 'Peers',
      width: proportional(1),
      renderCell: (item) => (
        <PeersCell
          row={item}
          peers={peers}
          peerQuantKeys={peerQuantKeys}
          peerModelKeys={peerModelKeys}
        />
      ),
    },
    {
      key: 'coldStorage',
      header: 'Cold Storage',
      width: proportional(1),
      renderCell: (item) => <ColdStorageCell row={item} />,
    },
  ];

  return <Table data={rows} columns={columns} idKey="key" />;
}
