'use client';

import {useEffect, useRef, useState, useCallback, useMemo} from 'react';
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
import {isDiffusersRepo} from '@/lib/diffusers';
import {fileBasename, fileJoinKey, peerFileKeys} from '@/lib/peer-paths';
import {coldStorageRollup} from '@/lib/cold-storage-rollup';
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
  type SizeBreakdownGroup,
  type SizeEntry,
} from '@/lib/model-row';
import {AuditCell, UpdateBadge} from '@/components/cells/audit-cell';
import {NameCell} from '@/components/cells/name-cell';
import {PeersCell, PeersHeader} from '@/components/cells/peers-cell';
import {ColdStorageCell} from '@/components/cells/cold-storage-cell';
import {SizeMismatchHover} from '@/components/cells/size-mismatch-hover';

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

  // Build lookup: peerAddress -> Set<file basename>. Files are matched across
  // hosts by basename because model names are derived per host and can
  // disagree for the same file (see lib/peer-paths.ts).
  const peerKeys = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [address, lo] of peerModels) {
      if (lo.type !== 'value') continue;
      map.set(address, peerFileKeys(lo.value));
    }
    return map;
  }, [peerModels]);

  // Build lookup: "modelName::quant" -> [{address, size}] across all peers
  // (split groups summed), to flag copies whose sizes disagree by location.
  const peerQuantSizes = useMemo(() => {
    const map = new Map<string, Array<{address: string; size: number}>>();
    for (const [address, lo] of peerModels) {
      if (lo.type !== 'value') continue;
      for (const m of lo.value) {
        // A diffusers pipeline reuses one basename across components (unet/ and
        // vae/ both ship diffusion_pytorch_model.safetensors), so a filename key
        // would compare unrelated components; its variants aren't size-checked
        // across locations.
        if (
          isDiffusersRepo(
            m.files.flatMap((f) =>
              f.isSplit ? f.files.map((s) => s.path) : [f.path],
            ),
          )
        )
          continue;
        for (const f of m.files) {
          // Join copies across locations by filename, not the quant label:
          // several `.bin`/`.safetensors` files in one repo can share a quant
          // (e.g. 'pytorch'), so keying by quant would compare the sizes of
          // unrelated files and report a spurious cross-location mismatch.
          const base = f.isSplit ? f.representativeFilename : f.filename;
          const key = `${m.name}::${base}`;
          const size = f.isSplit ? f.totalSize : f.size;
          const existing = map.get(key);
          if (existing) existing.push({address, size});
          else map.set(key, [{address, size}]);
        }
      }
    }
    return map;
  }, [peerModels]);

  const peerNameByAddr = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of peers) map.set(p.address, p.name);
    return map;
  }, [peers]);

  // Synthesize rows for quants that exist only on peers — absent from local
  // and cold storage — so the table shows everything reachable.
  const augmentedModels = useMemo(
    () => augmentWithPeerOnlyQuants(models, peerModels),
    [models, peerModels],
  );

  // Filter models to the active location tab.
  const effectiveModels = useMemo(() => {
    if (activeLocation === 'all') return augmentedModels;
    return augmentedModels
      .map((m) => {
        const quants = m.quants
          .filter((q) => {
            if (activeLocation === 'cold-storage') return q.inColdStorage;
            const keys = peerKeys.get(activeLocation);
            return (
              keys != null &&
              q.paths.some((p) =>
                keys.has(fileJoinKey(m.name, fileBasename(p))),
              )
            );
          })
          // On the cold-storage tab, delete/select via the cold-storage paths.
          .map((q) =>
            activeLocation === 'cold-storage' && q.coldPaths.length > 0
              ? {...q, paths: q.coldPaths}
              : q,
          );
        if (quants.length === 0) return null;
        const weights = quants.filter((q) => !q.isProjector);
        const sizes = weights.map((q) => q.size).filter((s) => s > 0);
        return {
          ...m,
          quants,
          minSize: sizes.length > 0 ? Math.min(...sizes) : 0,
          maxSize: sizes.length > 0 ? Math.max(...sizes) : 0,
          ...coldStorageRollup(quants),
        } satisfies ModelRow;
      })
      .filter((m): m is ModelRow => m !== null);
  }, [augmentedModels, activeLocation, peerKeys]);

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
      // Per-quant size breakdown across cold storage and peers. Locations
      // disagreeing mark the quant — and, rolled up, the model row. The
      // effective size is the largest known copy; smaller copies are
      // undersized.
      type QuantSizeInfo = {
        effectiveSize: number;
        breakdown: SizeEntry[];
        mismatch: boolean;
        undersized: Set<string>;
      };
      const quantInfo = new Map<string, QuantSizeInfo>();
      let anyQuantMismatch = false;
      for (const q of m.quants) {
        const quantKey = `${m.name}::${q.label}`;
        // Peer copies are keyed by filename (see peerQuantSizes), so this
        // quant's cross-location sizes are looked up by its file, not its label
        // — a label can cover several distinct files (e.g. two `.bin` weights).
        const fileKey = `${m.name}::${q.isSingleFile ? q.filename : q.displayName}`;
        const breakdown: SizeEntry[] = [];
        if (q.coldTotalSize > 0) {
          breakdown.push({
            id: 'cold-storage',
            location: 'Cold storage',
            size: q.coldTotalSize,
          });
        }
        for (const ps of peerQuantSizes.get(fileKey) ?? []) {
          breakdown.push({
            id: ps.address,
            location: peerNameByAddr.get(ps.address) ?? ps.address,
            size: ps.size,
          });
        }
        const distinct = new Set(breakdown.map((e) => e.size));
        const mismatch = distinct.size > 1;
        const effectiveSize =
          breakdown.length > 0
            ? Math.max(...breakdown.map((e) => e.size))
            : q.size;
        const undersized = new Set<string>();
        if (mismatch) {
          for (const e of breakdown) {
            if (e.size < effectiveSize) undersized.add(e.id);
          }
        }
        quantInfo.set(quantKey, {
          effectiveSize,
          breakdown,
          mismatch,
          undersized,
        });
        if (mismatch) anyQuantMismatch = true;
      }

      const effectiveQuantSizes = m.quants
        .filter((q) => !q.isProjector)
        .map(
          (q) =>
            quantInfo.get(`${m.name}::${q.label}`)?.effectiveSize ?? q.size,
        )
        .filter((s) => s > 0);
      const minSize =
        effectiveQuantSizes.length > 0 ? Math.min(...effectiveQuantSizes) : 0;
      const maxSize =
        effectiveQuantSizes.length > 0 ? Math.max(...effectiveQuantSizes) : 0;

      // One labelled breakdown per mismatched file, so the rolled-up model
      // row's warning icon shows the same per-location sizes its quant rows do
      // (the row is otherwise collapsed, leaving the icon unexplained).
      const mismatchGroups: SizeBreakdownGroup[] = m.quants
        .map((q) => ({
          label: q.label,
          info: quantInfo.get(`${m.name}::${q.label}`),
        }))
        .filter((x) => x.info?.mismatch === true)
        .map((x) => ({label: x.label, entries: x.info!.breakdown}));

      // A whole-repo model's invalid + missing files (when its repo-file list
      // has been fetched), for the audit hovercard's "why" and download action.
      const repoIssues = isWholeRepoModel(m)
        ? repoFiles
            .get(`${activeLocation}::${m.name}`)
            ?.filter((f) => f.state === 'invalid' || f.state === 'missing')
        : undefined;

      out.push({
        key: m.name,
        label: m.name,
        quantizations: m.quantizations,
        isSingleFile: false,
        filename: null,
        depth: 0,
        parentName: m.name,
        size: minSize === maxSize ? minSize : -1,
        sizeRange: minSize !== maxSize ? [minSize, maxSize] : null,
        inColdStorage: null,
        coldComplete: null,
        coldSize: null,
        allInColdStorage: m.allInColdStorage,
        noneInColdStorage: m.noneInColdStorage,
        paths: m.quants.flatMap((q) => q.paths),
        totalShards: 0,
        presentShards: 0,
        missingIndices: [],
        sizeMismatch: anyQuantMismatch,
        sizeBreakdown: null,
        ...(mismatchGroups.length > 0
          ? {sizeBreakdownGroups: mismatchGroups}
          : {}),
        undersizedLocations: new Set<string>(),
        ...(repoIssues && repoIssues.length > 0 ? {repoIssues} : {}),
      });
      if (!expanded.has(m.name)) continue;
      if (isWholeRepoModel(m)) {
        // Whole-repo model: list its repo files (present/missing/invalid)
        // instead of quants. Empty until the lazy fetch lands.
        for (const f of repoFiles.get(`${activeLocation}::${m.name}`) ?? []) {
          out.push({
            key: `${m.name}::file::${f.path}`,
            label: f.path,
            quantizations: '',
            isSingleFile: true,
            filename: f.path,
            depth: 1,
            parentName: m.name,
            size: f.size ?? f.expectedSize,
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
            sizeMismatch: false,
            sizeBreakdown: null,
            undersizedLocations: new Set<string>(),
            fileState: f.state,
          });
        }
        continue;
      }
      for (const q of m.quants) {
        const quantKey = `${m.name}::${q.label}`;
        const info = quantInfo.get(quantKey);
        out.push({
          key: quantKey,
          label: q.label,
          quantizations: '',
          isSingleFile: q.isSingleFile,
          filename: q.filename,
          depth: 1,
          parentName: m.name,
          size: info?.effectiveSize ?? q.size,
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
          sizeMismatch: info?.mismatch ?? false,
          sizeBreakdown: info?.mismatch ? info.breakdown : null,
          undersizedLocations: info?.undersized ?? new Set<string>(),
          isProjector: q.isProjector,
          precisions: q.precisions,
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
              sizeMismatch: false,
              sizeBreakdown: null,
              undersizedLocations: new Set<string>(),
            });
          }
        }
      }
    }
    return out;
  }, [
    effectiveModels,
    expanded,
    repoFiles,
    activeLocation,
    peerQuantSizes,
    peerNameByAddr,
  ]);

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
            header: <PeersHeader peers={peers} />,
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
