'use client';

import {useState, useCallback, useMemo} from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  Table,
  proportional,
  pixel,
  type TableColumn,
} from '@astryxdesign/core/Table';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Link} from '@astryxdesign/core/Link';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import type {Peer as PeerConfig} from '@/lib/config';
import type {PeerModels} from '@/components/peers/peer';
import type {AuditProgressEvent, AuditResult, AuditStatus} from '@/lib/audit';
import {modelDisplayName} from '@/lib/model-name';
import {fileBasename, peerFileBasenames} from '@/lib/peer-paths';
import {rowAudit, type RowAudit} from '@/lib/row-audit';

export interface ShardInfo {
  filename: string;
  size: number;
}

export interface QuantInfo {
  label: string;
  filename: string | null;
  displayName: string;
  isSingleFile: boolean;
  inColdStorage: boolean; // a file of this name exists in cold storage
  coldComplete: boolean; // ...and its size matches (a complete, identical copy)
  coldSize: number | null; // size of the cold copy, when present (for the tooltip)
  size: number;
  paths: string[];
  coldPaths: string[];
  shards: ShardInfo[];
  totalShards: number;
  presentShards: number;
  missingIndices: number[];
}

export type {LocationTab} from '@/components/models/location-tabs';
import type {LocationTab} from '@/components/models/location-tabs';

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
  coldComplete: boolean | null;
  coldSize: number | null;
  allInColdStorage: boolean;
  noneInColdStorage: boolean;
  paths: string[];
  totalShards: number;
  presentShards: number;
  missingIndices: number[];
}

const styles = stylex.create({
  indent1: {paddingInlineStart: '1.5rem'},
  indent2: {paddingInlineStart: '3rem'},
  // Cached (sidecar-derived) audit verdicts are toned down vs fresh results.
  dimmed: {opacity: 0.6},
});

export function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const AUDIT_BADGE: Record<
  AuditStatus,
  {label: string; variant: 'success' | 'error' | 'warning' | 'neutral'}
> = {
  pass: {label: 'Pass', variant: 'success'},
  incomplete: {label: 'Incomplete', variant: 'error'},
  'checksum-mismatch': {label: 'Mismatch', variant: 'error'},
  misplaced: {label: 'Misplaced', variant: 'warning'},
  duplicate: {label: 'Duplicate', variant: 'warning'},
  unverifiable: {label: 'Unverifiable', variant: 'neutral'},
  error: {label: 'Error', variant: 'error'},
};

// The expected value most relevant to a given failure, drawn from the HF source.
// Size isn't special-cased here: the `incomplete` message already names the
// expected size, and the HF block below always shows it.
function expectedDetail(f: AuditResult): string | null {
  if (!f.hf) return null;
  switch (f.status) {
    case 'checksum-mismatch':
      return `Expected sha256: ${f.hf.expectedSha256}`;
    case 'misplaced':
      return `Expected path: ${f.hf.expectedPath}`;
    default:
      return null;
  }
}

function AuditFailureContent({
  failures,
  onFix,
  fixing,
  onSetSource,
  onRedownload,
  redownloading,
  onShowRevisions,
  onFixDuplicate,
  fixingDuplicate,
}: {
  failures: AuditResult[];
  onFix?: (path: string) => void;
  fixing?: boolean;
  onSetSource?: (path: string) => void;
  onRedownload?: (file: AuditResult) => void;
  redownloading?: boolean;
  onShowRevisions?: (file: AuditResult) => void;
  onFixDuplicate?: (path: string) => void;
  fixingDuplicate?: boolean;
}) {
  return (
    <VStack gap={3}>
      {failures.map((f) => {
        const name = f.file.split('/').pop() ?? f.file;
        const detail = expectedDetail(f);
        const {label, variant} = AUDIT_BADGE[f.status];
        // Only non-cached misplaced files can be relocated server-side.
        const canFix = f.status === 'misplaced' && !f.cached && onFix != null;
        // Unverifiable files have no inferred source — let the user supply one.
        const canSetSource = f.status === 'unverifiable' && onSetSource != null;
        // Incomplete (partial) files can be re-fetched; the HF downloader
        // recovers the existing file in place, so it's never deleted first.
        const canRedownload =
          f.status === 'incomplete' && f.hf != null && onRedownload != null;
        // A size/checksum failure that scanned the repo's history carries the
        // revisions it ruled out, viewable in a modal.
        const canShowRevisions =
          (f.revisionsChecked?.length ?? 0) > 0 && onShowRevisions != null;
        // Duplicate groups can be resolved server-side: invalid/older copies
        // deleted, the surviving copy placed at the expected path.
        const canFixDuplicate =
          f.status === 'duplicate' && !f.cached && onFixDuplicate != null;
        return (
          <VStack
            key={f.file}
            gap={1}
            xstyle={f.cached ? styles.dimmed : undefined}
          >
            <Text type="body">
              {name}
              {f.cached ? ' (cached)' : ''}
            </Text>
            <HStack gap={2} vAlign="center">
              <Badge label={label} variant={variant} />
              {f.message && <Text type="supporting">{f.message}</Text>}
            </HStack>
            {detail && <Text type="supporting">{detail}</Text>}
            {f.hf && (
              <VStack gap={0}>
                {f.hf.expectedSize != null && (
                  <Text type="supporting">
                    Size: {formatSize(f.hf.expectedSize)}
                  </Text>
                )}
                {f.hf.commit && (
                  <Link href={f.hf.commitUrl ?? f.hf.fileUrl} isExternalLink>
                    Revision {f.hf.commit.slice(0, 12)}
                    {f.hf.commitDate && ` (${f.hf.commitDate.slice(0, 10)})`}
                  </Link>
                )}
                <Link href={f.hf.modelUrl} isExternalLink>
                  {f.hf.repoId}
                </Link>
                <Link href={f.hf.fileUrl} isExternalLink>
                  View file on HuggingFace
                </Link>
              </VStack>
            )}
            {canFix && (
              <HStack>
                <Button
                  label={fixing ? 'Fixing…' : 'Fix'}
                  variant="ghost"
                  size="sm"
                  onClick={() => onFix?.(f.file)}
                  isDisabled={fixing}
                />
              </HStack>
            )}
            {canFixDuplicate && (
              <HStack>
                <Button
                  label={fixingDuplicate ? 'Fixing…' : 'Fix'}
                  variant="ghost"
                  size="sm"
                  onClick={() => onFixDuplicate?.(f.file)}
                  isDisabled={fixingDuplicate}
                />
              </HStack>
            )}
            {canSetSource && (
              <HStack>
                <Button
                  label="Set source…"
                  variant="ghost"
                  size="sm"
                  onClick={() => onSetSource?.(f.file)}
                />
              </HStack>
            )}
            {canRedownload && (
              <HStack>
                <Button
                  label={redownloading ? 'Redownloading…' : 'Redownload'}
                  variant="ghost"
                  size="sm"
                  onClick={() => onRedownload?.(f)}
                  isDisabled={redownloading}
                />
              </HStack>
            )}
            {canShowRevisions && (
              <HStack>
                <Button
                  label="Checked revisions…"
                  variant="ghost"
                  size="sm"
                  onClick={() => onShowRevisions?.(f)}
                />
              </HStack>
            )}
          </VStack>
        );
      })}
    </VStack>
  );
}

function AuditCell({
  audit,
  failures,
  onFix,
  fixing,
  onSetSource,
  onRedownload,
  redownloading,
  onShowRevisions,
  onFixDuplicate,
  fixingDuplicate,
}: {
  audit: RowAudit;
  failures?: AuditResult[];
  onFix?: (path: string) => void;
  fixing?: boolean;
  onSetSource?: (path: string) => void;
  onRedownload?: (file: AuditResult) => void;
  redownloading?: boolean;
  onShowRevisions?: (file: AuditResult) => void;
  onFixDuplicate?: (path: string) => void;
  fixingDuplicate?: boolean;
}) {
  if (audit == null) return null;
  if (audit.kind === 'pending') {
    // Waiting for a worker (audits serialize on cold storage): a muted marker
    // until the file's start event arrives.
    if (audit.queued) {
      return <Badge label="Queued" variant="neutral" xstyle={styles.dimmed} />;
    }
    return (
      <HStack gap={2} vAlign="center" wrap="nowrap">
        <Badge label="Auditing…" variant="neutral" />
        {/* The percent tracks the SHA256 hashing — the long part of an audit. */}
        {audit.percent != null && (
          <Text type="supporting">{audit.percent}%</Text>
        )}
      </HStack>
    );
  }
  const {label, variant} = AUDIT_BADGE[audit.status];
  // Cached (metadata-derived) verdicts are toned down to contrast with fresh
  // results.
  const plainBadge = (
    <Badge
      label={label}
      variant={variant}
      xstyle={audit.cached ? styles.dimmed : undefined}
    />
  );
  const hasFailures =
    audit.status !== 'pass' && failures != null && failures.length > 0;
  if (!hasFailures) return plainBadge;
  return (
    <HoverCard
      placement="above"
      content={
        <AuditFailureContent
          failures={failures ?? []}
          onFix={onFix}
          fixing={fixing}
          onSetSource={onSetSource}
          onRedownload={onRedownload}
          redownloading={redownloading}
          onShowRevisions={onShowRevisions}
          onFixDuplicate={onFixDuplicate}
          fixingDuplicate={fixingDuplicate}
        />
      }
    >
      {plainBadge}
    </HoverCard>
  );
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

  // Model row. Show the repo segment of an org/repo identity; the full repo (when
  // the name carries one) and the quantizations live in the tooltip.
  const tooltip = row.label.includes('/')
    ? `Repository: ${row.label} · Quantizations: ${row.quantizations}`
    : `Quantizations: ${row.quantizations}`;
  return (
    <Button
      label={modelDisplayName(row.label)}
      variant="ghost"
      size="sm"
      icon={<Icon icon={isExpanded ? 'chevronDown' : 'chevronRight'} />}
      tooltip={tooltip}
      onClick={() => onToggle(row.parentName)}
    />
  );
}

function PeersCell({
  row,
  peers,
  peerBasenames,
}: {
  row: DisplayRow;
  peers: PeerConfig[];
  peerBasenames: Map<string, Set<string>>;
}) {
  if (peers.length === 0 || row.depth === 2) return null;
  return (
    <HStack gap={1} vAlign="center" wrap="nowrap">
      {peers.map((peer) => {
        // Joined by file basename, not model name: names are derived per host
        // and can disagree for the same file (see lib/peer-paths.ts).
        const names = peerBasenames.get(peer.address);
        const hasPeer =
          names != null && row.paths.some((p) => names.has(fileBasename(p)));
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

function ColdStorageCell({
  row,
  onFixIncomplete,
  fixing = false,
}: {
  row: DisplayRow;
  onFixIncomplete?: (paths: string[]) => void;
  fixing?: boolean;
}) {
  if (row.depth === 2) return null; // shards don't show cold storage status
  if (row.depth === 1) {
    if (!row.inColdStorage) return <Badge label="Missing" variant="red" />;
    if (row.coldComplete) return <Badge label="Yes" variant="green" />;
    // Present by name but a different size — a partial/mismatched cold copy.
    const incomplete = <Badge label="Incomplete" variant="orange" />;
    if (row.coldSize == null) return incomplete;
    // The partial cold copy can be completed by re-running the local → cold
    // copy, which resumes from the verified prefix already there.
    const canFix = onFixIncomplete != null && row.paths.length > 0;
    return (
      <HoverCard
        placement="above"
        content={
          <VStack gap={2}>
            <Text type="supporting">
              Cold copy {formatSize(row.coldSize)} — expected{' '}
              {formatSize(row.size)}
            </Text>
            {canFix && (
              <HStack>
                <Button
                  label={fixing ? 'Fixing…' : 'Fix'}
                  variant="ghost"
                  size="sm"
                  onClick={() => onFixIncomplete(row.paths)}
                  isDisabled={fixing}
                />
              </HStack>
            )}
          </VStack>
        }
      >
        {incomplete}
      </HoverCard>
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
  selected,
  onToggleSelected,
  locations,
  activeLocation = 'all',
  auditResults,
  auditedPaths,
  auditing = false,
  auditProgress,
  auditStarted,
  onClearAudit,
  onFixMisplaced,
  fixing = false,
  onSetSource,
  onRedownload,
  redownloading = false,
  onShowRevisions,
  onFixColdIncomplete,
  coldFixing = false,
  onFixDuplicate,
  fixingDuplicate = false,
}: {
  models: ModelRow[];
  peers: PeerConfig[];
  peerModels: Map<string, PeerModels>;
  selected?: Set<string>;
  onToggleSelected?: (paths: string[]) => void;
  locations?: LocationTab[];
  activeLocation?: string;
  auditResults?: Map<string, AuditResult>;
  auditedPaths?: Set<string>;
  auditing?: boolean;
  auditProgress?: Map<string, AuditProgressEvent>;
  auditStarted?: Set<string>;
  onClearAudit?: () => void;
  onFixMisplaced?: (paths: string[]) => void;
  fixing?: boolean;
  onSetSource?: (path: string) => void;
  onRedownload?: (file: AuditResult) => void;
  redownloading?: boolean;
  onShowRevisions?: (file: AuditResult) => void;
  onFixColdIncomplete?: (paths: string[]) => void;
  coldFixing?: boolean;
  onFixDuplicate?: (paths: string[]) => void;
  fixingDuplicate?: boolean;
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

  // Build lookup: peerAddress -> Set<file basename>. Files are matched across
  // hosts by basename because model names are derived per host and can
  // disagree for the same file (see lib/peer-paths.ts).
  const peerBasenames = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [address, lo] of peerModels) {
      if (lo.type !== 'value') continue;
      map.set(address, peerFileBasenames(lo.value));
    }
    return map;
  }, [peerModels]);

  // Filter models to the active location tab.
  const effectiveModels = useMemo(() => {
    if (activeLocation === 'all') return models;
    return models
      .map((m) => {
        const quants = m.quants
          .filter((q) => {
            if (activeLocation === 'cold-storage') return q.inColdStorage;
            const names = peerBasenames.get(activeLocation);
            return (
              names != null && q.paths.some((p) => names.has(fileBasename(p)))
            );
          })
          // On the cold-storage tab, delete/select via the cold-storage paths.
          .map((q) =>
            activeLocation === 'cold-storage' && q.coldPaths.length > 0
              ? {...q, paths: q.coldPaths}
              : q,
          );
        if (quants.length === 0) return null;
        const sizes = quants.map((q) => q.size).filter((s) => s > 0);
        return {
          ...m,
          quants,
          minSize: sizes.length > 0 ? Math.min(...sizes) : 0,
          maxSize: sizes.length > 0 ? Math.max(...sizes) : 0,
          allInColdStorage: quants.every((q) => q.inColdStorage),
          noneInColdStorage: quants.every((q) => !q.inColdStorage),
        } satisfies ModelRow;
      })
      .filter((m): m is ModelRow => m !== null);
  }, [models, activeLocation, peerBasenames]);

  const showCheckboxes = onToggleSelected != null;

  // Every selectable file path in the current tab's view, for the select-all
  // header checkbox. Same toggle semantics as a row: all selected → clear.
  const allVisiblePaths = useMemo(
    () => effectiveModels.flatMap((m) => m.quants.flatMap((q) => q.paths)),
    [effectiveModels],
  );

  // Everything the current view can expand: each model, and each split
  // quant's shard group. Drives the expand-all chevron in the Model header.
  const allExpandableKeys = useMemo(() => {
    const keys: string[] = [];
    for (const m of effectiveModels) {
      keys.push(m.name);
      for (const q of m.quants) {
        if (!q.isSingleFile) keys.push(`${m.name}::${q.label}`);
      }
    }
    return keys;
  }, [effectiveModels]);

  const toggleAll = useCallback(() => {
    setExpanded((prev) => {
      const allExpanded = allExpandableKeys.every((k) => prev.has(k));
      return allExpanded ? new Set() : new Set(allExpandableKeys);
    });
  }, [allExpandableKeys]);

  // Memoized so row objects keep their identity across unrelated re-renders;
  // Table's per-row memo bails out via shallow compare otherwise (the nested
  // paths/sizeRange arrays would be rebuilt every render).
  const rows: DisplayRow[] = useMemo(() => {
    const out: DisplayRow[] = [];
    for (const m of effectiveModels) {
      out.push({
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
        coldComplete: null,
        coldSize: null,
        allInColdStorage: m.allInColdStorage,
        noneInColdStorage: m.noneInColdStorage,
        paths: m.quants.flatMap((q) => q.paths),
        totalShards: 0,
        presentShards: 0,
        missingIndices: [],
      });
      if (!expanded.has(m.name)) continue;
      for (const q of m.quants) {
        const quantKey = `${m.name}::${q.label}`;
        out.push({
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
          coldComplete: q.coldComplete,
          coldSize: q.coldSize,
          allInColdStorage: false,
          noneInColdStorage: false,
          paths: q.paths,
          totalShards: q.totalShards,
          presentShards: q.presentShards,
          missingIndices: q.missingIndices,
        });
        if (!q.isSingleFile && expanded.has(quantKey)) {
          for (const shard of q.shards) {
            out.push({
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
              coldComplete: null,
              coldSize: null,
              allInColdStorage: false,
              noneInColdStorage: false,
              paths: [],
              totalShards: 0,
              presentShards: 0,
              missingIndices: [],
            });
          }
        }
      }
    }
    return out;
  }, [effectiveModels, expanded]);

  const columns: TableColumn<DisplayRow>[] = [
    ...(showCheckboxes
      ? [
          {
            key: 'select',
            header: (() => {
              const allSelected =
                selected != null &&
                allVisiblePaths.length > 0 &&
                allVisiblePaths.every((p) => selected.has(p));
              const someSelected =
                selected != null &&
                allVisiblePaths.some((p) => selected.has(p));
              return (
                <CheckboxInput
                  label="Select all rows"
                  isLabelHidden
                  value={
                    allSelected ? true : someSelected ? 'indeterminate' : false
                  }
                  onChange={() => onToggleSelected!(allVisiblePaths)}
                  isDisabled={allVisiblePaths.length === 0}
                />
              );
            })(),
            width: pixel(36),
            align: 'center' as const,
            renderCell: (item: DisplayRow) => {
              if (item.depth === 2 || item.paths.length === 0) return null;
              const allSelected =
                selected != null &&
                item.paths.length > 0 &&
                item.paths.every((p) => selected.has(p));
              const someSelected =
                selected != null && item.paths.some((p) => selected.has(p));
              return (
                <CheckboxInput
                  label={`Select ${item.label}`}
                  isLabelHidden
                  value={
                    allSelected ? true : someSelected ? 'indeterminate' : false
                  }
                  onChange={() => onToggleSelected!(item.paths)}
                />
              );
            },
          } satisfies TableColumn<DisplayRow>,
        ]
      : []),
    {
      key: 'label',
      header: (() => {
        const allExpanded =
          allExpandableKeys.length > 0 &&
          allExpandableKeys.every((k) => expanded.has(k));
        return (
          <HStack gap={1} vAlign="center" wrap="nowrap">
            <IconButton
              label={allExpanded ? 'Collapse all rows' : 'Expand all rows'}
              tooltip={allExpanded ? 'Collapse all rows' : 'Expand all rows'}
              icon={
                <Icon icon={allExpanded ? 'chevronDown' : 'chevronRight'} />
              }
              variant="ghost"
              size="sm"
              onClick={toggleAll}
              isDisabled={allExpandableKeys.length === 0}
            />
            <Text type="body">Model</Text>
          </HStack>
        );
      })(),
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
    // Peers column only on the "All" tab (redundant on a peer's own tab and on
    // the cold-storage tab).
    ...(activeLocation !== 'cold-storage' &&
    !locations?.some((l) => l.id === activeLocation)
      ? [
          {
            key: 'peers',
            header: 'Peers',
            width: pixel(120),
            align: 'center' as const,
            renderCell: (item: DisplayRow) => (
              <PeersCell
                row={item}
                peers={peers}
                peerBasenames={peerBasenames}
              />
            ),
          } satisfies TableColumn<DisplayRow>,
        ]
      : []),
    // Cold Storage column hidden on the cold-storage tab itself.
    ...(activeLocation !== 'cold-storage'
      ? [
          {
            key: 'coldStorage',
            header: 'Cold Storage',
            width: pixel(100),
            align: 'center' as const,
            renderCell: (item: DisplayRow) => (
              <ColdStorageCell
                row={item}
                onFixIncomplete={onFixColdIncomplete}
                fixing={coldFixing}
              />
            ),
          } satisfies TableColumn<DisplayRow>,
        ]
      : []),
    // Audit column appears only once an audit has been run on some selection.
    ...(auditedPaths && auditedPaths.size > 0
      ? [
          {
            key: 'audit',
            header: (
              <HStack gap={1} vAlign="center" wrap="nowrap">
                <Text type="body">Audit</Text>
                {/* Leave audit mode: clear every verdict, which hides the
                    column. Hidden while a run is streaming results. */}
                {onClearAudit && !auditing && (
                  <IconButton
                    label="Clear audit results"
                    tooltip="Clear audit results"
                    icon={<Icon icon="close" size="xsm" />}
                    variant="ghost"
                    size="sm"
                    onClick={onClearAudit}
                  />
                )}
              </HStack>
            ),
            // Wide enough for the longest token, "Auditing… 100%", without
            // wrapping.
            width: pixel(170),
            align: 'center' as const,
            renderCell: (item: DisplayRow) => {
              const results = auditResults ?? new Map<string, AuditResult>();
              const failures = item.paths
                .map((p) => results.get(p))
                .filter(
                  (r): r is AuditResult => r != null && r.status !== 'pass',
                );
              return (
                <AuditCell
                  audit={rowAudit(
                    item.paths,
                    auditedPaths,
                    results,
                    auditing,
                    auditProgress,
                    auditStarted,
                  )}
                  failures={failures}
                  onFix={
                    onFixMisplaced
                      ? (path) => onFixMisplaced([path])
                      : undefined
                  }
                  fixing={fixing}
                  onSetSource={onSetSource}
                  onRedownload={onRedownload}
                  redownloading={redownloading}
                  onShowRevisions={onShowRevisions}
                  onFixDuplicate={
                    onFixDuplicate
                      ? (path) => onFixDuplicate([path])
                      : undefined
                  }
                  fixingDuplicate={fixingDuplicate}
                />
              );
            },
          } satisfies TableColumn<DisplayRow>,
        ]
      : []),
  ];

  return <Table data={rows} columns={columns} idKey="key" />;
}
