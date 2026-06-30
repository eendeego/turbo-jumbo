'use client';

import {useState, useCallback} from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  Table,
  proportional,
  pixel,
  type TableColumn,
} from '@astryxdesign/core/Table';
import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import type {Peer as PeerConfig} from '@/lib/config';
import type {PeerModels} from '@/components/peers/peer';

export interface ShardInfo {
  filename: string;
  size: number;
}

export interface QuantInfo {
  label: string;
  filename: string | null;
  isSingleFile: boolean;
  inColdStorage: boolean;
  size: number;
  shards: ShardInfo[];
  totalShards: number;
  presentShards: number;
  missingIndices: number[];
}

export interface ModelRow extends Record<string, unknown> {
  name: string;
  quantizations: string;
  quants: QuantInfo[];
  minSize: number;
  maxSize: number;
  allInColdStorage: boolean;
  noneInColdStorage: boolean;
}

interface DisplayRow extends Record<string, unknown> {
  key: string;
  label: string;
  quantizations: string;
  isSingleFile: boolean;
  filename: string | null;
  depth: number; // 0=model, 1=quant, 2=shard
  parentName: string;
  size: number;
  sizeRange: [number, number] | null;
  inColdStorage: boolean | null;
  allInColdStorage: boolean;
  noneInColdStorage: boolean;
  totalShards: number;
  presentShards: number;
  missingIndices: number[];
}

const styles = stylex.create({
  indent1: {paddingInlineStart: '1.5rem'},
  indent2: {paddingInlineStart: '3rem'},
});

function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function NameCell({
  row,
  isExpanded,
  onToggle,
}: {
  row: DisplayRow;
  isExpanded: boolean;
  onToggle: (key: string) => void;
}) {
  // Shard row
  if (row.depth === 2) {
    return (
      <Text type="supporting" xstyle={styles.indent2}>
        {row.label}
      </Text>
    );
  }

  // Quant row
  if (row.depth === 1) {
    if (row.isSingleFile) {
      return (
        <HStack gap={2} vAlign="center" xstyle={styles.indent1}>
          <Text type="body">{row.label}</Text>
          <Text type="supporting">{row.filename}</Text>
        </HStack>
      );
    }
    // Split quant: expandable to its shards
    return (
      <Button
        label={row.label}
        variant="ghost"
        size="sm"
        xstyle={styles.indent1}
        icon={<Icon icon={isExpanded ? 'chevronDown' : 'chevronRight'} />}
        endContent={
          <HStack gap={2} vAlign="center">
            <Text type="supporting">
              {row.presentShards}/{row.totalShards} files
            </Text>
            {row.missingIndices.length > 0 && (
              <Badge
                variant="orange"
                label={`missing: ${row.missingIndices.join(', ')}`}
              />
            )}
          </HStack>
        }
        onClick={() => onToggle(row.key)}
      />
    );
  }

  // Model row
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
  if (peers.length === 0 || row.depth === 2) return null;
  return (
    <HStack gap={1} vAlign="center" wrap="nowrap">
      {peers.map((peer) => {
        const quantKey = `${row.parentName}::${row.label}`;
        const hasPeer =
          row.depth > 0
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
  if (row.depth === 2) return null; // shards don't show cold storage status
  if (row.depth === 1) {
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

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
      depth: 0,
      parentName: m.name,
      size: m.minSize === m.maxSize ? m.minSize : -1,
      sizeRange: m.minSize !== m.maxSize ? [m.minSize, m.maxSize] : null,
      inColdStorage: null,
      allInColdStorage: m.allInColdStorage,
      noneInColdStorage: m.noneInColdStorage,
      totalShards: 0,
      presentShards: 0,
      missingIndices: [],
    });
    if (!expanded.has(m.name)) continue;
    for (const q of m.quants) {
      const quantKey = `${m.name}::${q.label}`;
      rows.push({
        key: quantKey,
        label: q.label,
        quantizations: '',
        isSingleFile: q.isSingleFile,
        filename: q.filename,
        depth: 1,
        parentName: m.name,
        size: q.size,
        sizeRange: null,
        inColdStorage: q.inColdStorage,
        allInColdStorage: false,
        noneInColdStorage: false,
        totalShards: q.totalShards,
        presentShards: q.presentShards,
        missingIndices: q.missingIndices,
      });
      if (!q.isSingleFile && expanded.has(quantKey)) {
        for (const shard of q.shards) {
          rows.push({
            key: `${quantKey}::${shard.filename}`,
            label: shard.filename,
            quantizations: '',
            isSingleFile: false,
            filename: null,
            depth: 2,
            parentName: m.name,
            size: shard.size,
            sizeRange: null,
            inColdStorage: null,
            allInColdStorage: false,
            noneInColdStorage: false,
            totalShards: 0,
            presentShards: 0,
            missingIndices: [],
          });
        }
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
          isExpanded={expanded.has(
            item.depth === 0 ? item.parentName : item.key,
          )}
          onToggle={toggle}
        />
      ),
    },
    {
      key: 'size',
      header: 'Size',
      width: pixel(120),
      align: 'end',
      renderCell: (item) => (
        <Text type="body">
          {item.sizeRange
            ? `${formatSize(item.sizeRange[0])} – ${formatSize(item.sizeRange[1])}`
            : formatSize(item.size)}
        </Text>
      ),
    },
    {
      key: 'peers',
      header: 'Peers',
      width: pixel(120),
      align: 'center',
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
      width: pixel(100),
      align: 'center',
      renderCell: (item) => <ColdStorageCell row={item} />,
    },
  ];

  return <Table data={rows} columns={columns} idKey="key" />;
}
