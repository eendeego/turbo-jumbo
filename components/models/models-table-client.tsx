'use client';

import {useEffect, useRef, useState, useCallback} from 'react';
import {
  Table,
  proportional,
  pixel,
  type TableColumn,
} from '@astryxdesign/core/Table';
import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import type {Peer as PeerConfig} from '@/lib/config';
import type {PeerModels} from '@/components/peers/peer';
import type {AuditProgressEvent, AuditResult, UpdateResult} from '@/lib/audit';
import {rowAudit, rowUpdates} from '@/lib/row-audit';
import type {RepoFile} from '@/lib/repo-files';
import {
  augmentWithPeerOnlyQuants,
  formatSize,
  isWholeRepoModel,
  peersColumnWidth,
  type DisplayRow,
  type ModelRow,
  type QuantInfo,
  type ShardInfo,
} from '@/lib/model-row';
import {AuditCell, UpdateBadge} from '@/components/cells/audit-cell';
import {NameCell} from '@/components/cells/name-cell';
import {PeersCell} from '@/components/cells/peers-cell';
import {ColdStorageCell} from '@/components/cells/cold-storage-cell';
import {SizeMismatchHover} from '@/components/cells/size-mismatch-hover';
import {useDisplayRows} from '@/components/models/use-display-rows';

// The model-row data layer (types + pure helpers) lives in lib/model-row; these
// are re-exported here for existing importers (peer-paths, home-client,
// revisions-modal).
export {augmentWithPeerOnlyQuants, formatSize};
export type {ModelRow, QuantInfo, ShardInfo};

export type {LocationTab} from '@/components/models/location-tabs';
import type {LocationTab} from '@/components/models/location-tabs';

export function ModelsTableClient({
  models,
  peers,
  peerModels,
  incompleteRepos,
  invalidRepos,
  selected,
  onToggleSelected,
  locations,
  activeLocation = 'all',
  auditResults,
  auditedPaths,
  auditing = false,
  auditProgress,
  auditStarted,
  updateResults,
  onClearAudit,
  onFixMisplaced,
  fixing = false,
  onSetSource,
  onRedownload,
  redownloading = false,
  onDownloadRepoFiles,
  onShowRevisions,
  onFixColdIncomplete,
  coldFixing = false,
  onFixDuplicate,
  fixingDuplicate = false,
}: {
  models: ModelRow[];
  peers: PeerConfig[];
  peerModels: Map<string, PeerModels>;
  // Repo ids (model names) whose local copy is present but incomplete.
  incompleteRepos?: Set<string>;
  // Repo ids (model names) with at least one local file that audits invalid.
  invalidRepos?: Set<string>;
  selected?: Set<string>;
  onToggleSelected?: (paths: string[]) => void;
  locations?: LocationTab[];
  activeLocation?: string;
  auditResults?: Map<string, AuditResult>;
  auditedPaths?: Set<string>;
  auditing?: boolean;
  auditProgress?: Map<string, AuditProgressEvent>;
  auditStarted?: Set<string>;
  updateResults?: Map<string, UpdateResult>;
  onClearAudit?: () => void;
  onFixMisplaced?: (paths: string[]) => void;
  fixing?: boolean;
  onSetSource?: (path: string) => void;
  onRedownload?: (file: AuditResult) => void;
  redownloading?: boolean;
  // Download a whole-repo model's invalid + missing files (from its hovercard).
  onDownloadRepoFiles?: (repoId: string, repoPaths: string[]) => void;
  onShowRevisions?: (file: AuditResult) => void;
  onFixColdIncomplete?: (paths: string[]) => void;
  coldFixing?: boolean;
  onFixDuplicate?: (paths: string[]) => void;
  fixingDuplicate?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Per-repo file lists for expanded whole-repo models, keyed by
  // `<location>::<model name>` (file status is per location), fetched lazily on
  // expand. In-flight fetches are tracked in a ref so marking one doesn't
  // trigger a render.
  const [repoFiles, setRepoFiles] = useState<Map<string, RepoFile[]>>(
    new Map(),
  );
  const inFlight = useRef<Set<string>>(new Set());

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Fetch the file list for whole-repo models when they're expanded — and
  // eagerly for any flagged invalid, so the audit hovercard can name the bad
  // files without an expansion. Against the active location (the local store, or
  // a peer proxied to its own endpoint).
  useEffect(() => {
    const peer = peers.find((p) => p.address === activeLocation);
    const urlFor = (repoId: string) =>
      peer
        ? `/api/v1/peers/${encodeURIComponent(peer.name)}/repo-files?repoId=${encodeURIComponent(repoId)}`
        : `/api/v1/local-models/repo-files?repoId=${encodeURIComponent(repoId)}`;
    const wanted = new Set<string>(expanded);
    for (const name of invalidRepos ?? []) wanted.add(name);
    for (const name of wanted) {
      const key = `${activeLocation}::${name}`;
      if (repoFiles.has(key) || inFlight.current.has(key)) continue;
      const m = models.find((mm) => mm.name === name);
      if (!m || !isWholeRepoModel(m)) continue;
      inFlight.current.add(key);
      void (async () => {
        let files: RepoFile[] = [];
        try {
          const res = await fetch(urlFor(name));
          if (res.ok)
            files = ((await res.json()) as {files?: RepoFile[]}).files ?? [];
        } catch {
          /* best-effort: leave the list empty */
        }
        inFlight.current.delete(key);
        setRepoFiles((prev) => new Map(prev).set(key, files));
      })();
    }
  }, [expanded, models, peers, activeLocation, repoFiles, invalidRepos]);

  // The table's row data and the lookups its header/cells need, derived from
  // the models, peer inventories and current expansion (see useDisplayRows).
  const {rows, peerKeys, allVisiblePaths, allExpandableKeys} = useDisplayRows({
    models,
    peers,
    peerModels,
    activeLocation,
    expanded,
    repoFiles,
  });

  const showCheckboxes = onToggleSelected != null;

  const toggleAll = useCallback(() => {
    setExpanded((prev) => {
      const allExpanded = allExpandableKeys.every((k) => prev.has(k));
      return allExpanded ? new Set() : new Set(allExpandableKeys);
    });
  }, [allExpandableKeys]);

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
          incomplete={
            item.depth === 0 && (incompleteRepos?.has(item.parentName) ?? false)
          }
          invalid={
            item.depth === 0 && (invalidRepos?.has(item.parentName) ?? false)
          }
        />
      ),
    },
    {
      key: 'size',
      header: 'Size',
      // A two-ended range ("12.3 GB – 45.6 GB") plus the mismatch icon needs
      // ~160px; give it headroom for larger ranges.
      width: pixel(200),
      align: 'end',
      renderCell: (item) => (
        <HStack gap={1} vAlign="center" hAlign="end">
          {item.sizeMismatch &&
            (() => {
              const groups =
                item.sizeBreakdownGroups ??
                (item.sizeBreakdown
                  ? [{label: null, entries: item.sizeBreakdown}]
                  : null);
              return groups ? (
                <SizeMismatchHover groups={groups} />
              ) : (
                <Icon icon="warning" size="sm" />
              );
            })()}
          <Text type="body">
            {item.sizeRange
              ? `${formatSize(item.sizeRange[0])} – ${formatSize(item.sizeRange[1])}`
              : formatSize(item.size)}
          </Text>
        </HStack>
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
            width: pixel(peersColumnWidth(peers.length)),
            align: 'center' as const,
            renderCell: (item: DisplayRow) =>
              item.fileState ? null : (
                <PeersCell row={item} peers={peers} peerKeys={peerKeys} />
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
            // Fits the "Cold Storage" header, wider than any of its tokens.
            width: pixel(120),
            align: 'center' as const,
            renderCell: (item: DisplayRow) =>
              item.fileState ? null : (
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
              if (item.fileState) return null;
              const results = auditResults ?? new Map<string, AuditResult>();
              // A model (depth 0) row also shows verdicts for files that
              // belong to it but aren't on disk — e.g. a synthetic
              // missing-mmproj verdict keyed `<repoId>/mmproj-F16.gguf`.
              const companionPaths =
                item.depth === 0
                  ? [...results.keys()].filter(
                      (p) =>
                        p.startsWith(item.key + '/') && !item.paths.includes(p),
                    )
                  : [];
              const auditPaths = [...item.paths, ...companionPaths];
              const failures = auditPaths
                .map((p) => results.get(p))
                .filter(
                  (r): r is AuditResult => r != null && r.status !== 'pass',
                );
              const updates = rowUpdates(item.paths, updateResults);
              return (
                // The column's align: 'center' centers this wrapper in the
                // cell; the wrapper just lays the audit token and update badge
                // in a row with a gap.
                <HStack gap={1} vAlign="center" wrap="nowrap">
                  <AuditCell
                    audit={rowAudit(
                      auditPaths,
                      auditedPaths,
                      results,
                      auditing,
                      auditProgress,
                      auditStarted,
                    )}
                    failures={failures}
                    invalid={
                      item.depth === 0 &&
                      (invalidRepos?.has(item.parentName) ?? false)
                    }
                    coldIncomplete={item.coldIncomplete}
                    onCopyToCold={
                      onFixColdIncomplete
                        ? () => onFixColdIncomplete(item.paths)
                        : undefined
                    }
                    copyingToCold={coldFixing}
                    repoIssues={item.repoIssues}
                    repoId={item.parentName}
                    onDownloadFiles={onDownloadRepoFiles}
                    downloadingFiles={redownloading}
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
                  {updates.length > 0 && <UpdateBadge updates={updates} />}
                </HStack>
              );
            },
          } satisfies TableColumn<DisplayRow>,
        ]
      : []),
  ];

  return <Table data={rows} columns={columns} idKey="key" />;
}
