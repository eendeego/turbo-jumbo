import type {AsyncState} from '@/lib/async-state';
import type {Model} from '@/lib/model-types';
import type {RepoFile, RepoFileState} from '@/lib/repo-files';
import {
  isMmprojFilename,
  compareByRepoName,
  modelDisplayName,
  modelOrg,
} from '@/lib/model-name';
import {fileBasename, fileJoinKey} from '@/lib/peer-paths';
import {ggmlModelVariant} from '@/lib/weight-files';
import {isPickOneSafetensorsRepo} from '@/lib/hf-download';
import {isDiffusersRepo} from '@/lib/diffusers';
import {coldStorageRollup} from '@/lib/cold-storage-rollup';
import type {SidecarSummary} from '@/lib/model-sidecar';

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
  coldTotalSize: number; // total size of the cold copy, splits summed (0 when absent)
  size: number;
  paths: string[];
  coldPaths: string[];
  shards: ShardInfo[];
  totalShards: number;
  presentShards: number;
  missingIndices: number[];
  isProjector?: boolean;
  // The precisions present for a diffusers component (fp16 / fp32), shown as a
  // badge; undefined for non-diffusers quants.
  precisions?: string[];
}

export interface ModelRow extends Record<string, unknown> {
  name: string;
  quantizations: string;
  quants: QuantInfo[];
  minSize: number;
  maxSize: number;
  allInColdStorage: boolean;
  noneInColdStorage: boolean;
  // The model-level sidecar summary of the local copy, falling back to the
  // cold copy; undefined when neither carries a sidecar.
  sidecar?: SidecarSummary;
}

// One location's copy of a quant, for the size-mismatch breakdown.
export type SizeEntry = {id: string; location: string; size: number};

// A size-mismatch breakdown, optionally labelled by the file it belongs to.
// Quant rows carry a single unlabelled group; the rolled-up model row carries
// one labelled group per mismatched file so its warning is hoverable too.
export type SizeBreakdownGroup = {label: string | null; entries: SizeEntry[]};

export interface DisplayRow extends Record<string, unknown> {
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
  sizeMismatch: boolean;
  sizeBreakdown: SizeEntry[] | null;
  // Set only on a model (rollup) row: one labelled group per mismatched file,
  // so its warning icon shows a hovercard like the per-quant rows do.
  sizeBreakdownGroups?: SizeBreakdownGroup[];
  undersizedLocations: Set<string>;
  // The cold-storage copy of this row's file(s) exists but is smaller than the
  // largest known copy — an incomplete backup. Set on quant and model rows so
  // the Audit column can fail it even on a tab whose own copy verifies (a peer
  // holding the complete file still leaves the cold backup broken).
  coldIncomplete: boolean;
  isProjector?: boolean;
  // Precisions present for a diffusers component variant row (e.g. ['fp16']).
  precisions?: string[];
  // Set on a whole-repo model's per-file child rows (present/missing/invalid).
  fileState?: RepoFileState;
  // Set on a whole-repo model row (depth 0): its invalid + missing files, for
  // the audit hovercard's "why" list and the download action.
  repoIssues?: RepoFile[];
  // Set on a model row (depth 0) whose repo name is shared with an adjacent
  // model from a different org: the org to show as a disambiguating suffix.
  orgSuffix?: string;
  // Set on a model row (depth 0): the model-level sidecar summary, for the
  // name hovercard. Undefined on quant/shard/file rows and sidecar-less models.
  sidecar?: SidecarSummary;
}

// A peer's copy of a row's files relative to what's expected.
export type PeerPresence = 'present' | 'absent' | 'undersized';

export function formatSize(bytes: number): string {
  if (bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// Mirrors the server-side helper in models-table.tsx (not importable here:
// that module reads server config).
function quantBits(quant: string): string {
  const m = quant.match(/\d+/);
  return m ? m[0] : quant;
}

// A whole-repo (non-GGUF) model — ONNX/safetensors/etc. Its expansion lists the
// repo's files rather than quants. A model name without `org/repo` (so no HF
// repo to query) is excluded.
export function isWholeRepoModel(m: ModelRow): boolean {
  return (
    m.name.includes('/') &&
    m.quants.length > 0 &&
    m.quants.every((q) => {
      const f = (q.filename ?? q.displayName ?? '').toLowerCase();
      return f !== '' && !f.endsWith('.gguf');
    }) &&
    // A repo of standalone ggml-*.bin models is a collection of single-file
    // variants — each selectable and copyable like a GGUF quant — not one
    // whole-repo model spread across many files.
    !m.quants.every(
      (q) => ggmlModelVariant(q.filename ?? q.displayName ?? '') !== null,
    ) &&
    // A Comfy-Org split_files safetensors bundle is likewise a collection of
    // independent component/quant files, shown as variant rows, not a whole repo.
    !isPickOneSafetensorsRepo(m.quants.flatMap((q) => q.paths)) &&
    // A diffusers pipeline is shown as present-only, precision-collapsed
    // component variant rows (see buildModelRows), not a whole-repo file list.
    !isDiffusersRepo(m.quants.flatMap((q) => q.paths))
  );
}

/**
 * Minimum width (px) for the Peers column. The column is fixed under the table's
 * fixed layout, so it can't grow to its content — size it to the wider of the
 * per-peer badges (24px each, 6px gap) and the "Peers" + initials header, plus
 * the cell's horizontal padding. Scales with the peer count so the column holds
 * no more empty space than the badges need.
 */
export function peersColumnWidth(count: number): number {
  const badges = count * 24 + Math.max(0, count - 1) * 6;
  const header = 40 + count * 13; // "Peers" label + one initial per peer
  return Math.max(badges, header) + 24; // + cell padding (12px each side)
}

/**
 * Extend `models` with quants that exist only on peers — absent from local
 * and cold storage — so peer-only files are visible and selectable. The first
 * peer naming a quant supplies its representation; its paths are the peer's
 * own. Exported so the copy/delete modals resolve selections against the same
 * augmented view the table renders.
 */
export function augmentWithPeerOnlyQuants(
  models: ModelRow[],
  peerModels: Map<string, AsyncState<Model[]>>,
): ModelRow[] {
  // File identities already shown from local/cold storage, keyed the same way
  // the peer-presence badges join (fileJoinKey: a specific GGUF basename on its
  // own, a generic weight qualified by model). A peer file matching one of these
  // is the *same* file — it belongs as a presence badge on the existing row, not
  // a duplicate row under the peer's (often differently-derived) model name.
  // Keying on the model::label string instead would miss exactly that case (the
  // peer names the model `org/repo-GGUF`, local names it from the filename), so
  // the file would be selectable under two rows that share one path.
  const existingFileKeys = new Set<string>();
  // File-join key → the local model row it belongs to. A peer that shares any
  // file with a local row is the same model named differently, so its genuinely
  // peer-only files (e.g. an mmproj the local copy lacks) reconcile onto that
  // row instead of opening a second one under the peer's repo-derived name.
  const localNameByFileKey = new Map<string, string>();
  for (const m of models) {
    for (const q of m.quants) {
      for (const p of [...q.paths, ...q.coldPaths]) {
        const k = fileJoinKey(m.name, fileBasename(p));
        existingFileKeys.add(k);
        if (!localNameByFileKey.has(k)) localNameByFileKey.set(k, m.name);
      }
    }
  }

  // The local row a peer model maps onto (via any shared file), or its own name
  // when it matches nothing local.
  const reconciledName = (peer: Model): string => {
    for (const f of peer.files) {
      const paths = f.isSplit ? f.files.map((s) => s.path) : [f.path];
      for (const p of paths) {
        const local = localNameByFileKey.get(
          fileJoinKey(peer.name, fileBasename(p)),
        );
        if (local) return local;
      }
    }
    return peer.name;
  };

  // Gather peer-only quants, picking the first peer's representation.
  type PeerOnly = {
    modelName: string;
    label: string;
    isProjector: boolean;
    isSingleFile: boolean;
    filename: string | null;
    displayName: string;
    size: number;
    paths: string[];
    totalShards: number;
    presentShards: number;
    missingIndices: number[];
  };
  const peerOnly = new Map<string, PeerOnly>();
  for (const [, lo] of peerModels) {
    if (lo.type !== 'value') continue;
    for (const m of lo.value) {
      const modelName = reconciledName(m);
      for (const f of m.files) {
        const base = f.isSplit ? f.representativeFilename : f.filename;
        const label = isMmprojFilename(base) ? base : f.quant;
        const paths = f.isSplit ? f.files.map((s) => s.path) : [f.path];
        // Already represented locally/in cold storage (same file, different
        // host naming) → leave it to the presence badges, don't add a row.
        if (
          paths.some((p) =>
            existingFileKeys.has(fileJoinKey(m.name, fileBasename(p))),
          )
        )
          continue;
        const key = `${modelName}::${label}`;
        if (peerOnly.has(key)) continue;
        peerOnly.set(key, {
          modelName,
          label,
          isProjector: isMmprojFilename(base),
          isSingleFile: !f.isSplit,
          filename: f.isSplit ? null : f.filename,
          displayName: f.isSplit ? f.representativeFilename : f.filename,
          size: f.isSplit ? f.totalSize : f.size,
          paths,
          totalShards: f.isSplit ? f.totalShards : 0,
          presentShards: f.isSplit ? f.presentShards : 0,
          missingIndices: f.isSplit ? f.missingIndices : [],
        });
      }
    }
  }

  if (peerOnly.size === 0) return models;

  const byModel = new Map<string, ModelRow>();
  for (const m of models) byModel.set(m.name, {...m, quants: [...m.quants]});

  for (const p of peerOnly.values()) {
    const quant: QuantInfo = {
      label: p.label,
      isSingleFile: p.isSingleFile,
      filename: p.filename,
      displayName: p.displayName,
      inColdStorage: false,
      coldComplete: false,
      coldSize: null,
      coldTotalSize: 0,
      size: p.size,
      paths: p.paths,
      coldPaths: [],
      shards: [],
      totalShards: p.totalShards,
      presentShards: p.presentShards,
      missingIndices: p.missingIndices,
      isProjector: p.isProjector,
    };
    const existing = byModel.get(p.modelName);
    if (existing) {
      existing.quants.push(quant);
    } else {
      byModel.set(p.modelName, {
        name: p.modelName,
        quantizations: '',
        quants: [quant],
        minSize: 0,
        maxSize: 0,
        allInColdStorage: false,
        noneInColdStorage: true,
      });
    }
  }

  // Recompute aggregates and ordering; mirrors the server-side aggregation
  // in models-table.tsx.
  return [...byModel.values()]
    .map((m) => {
      const quants = [...m.quants].sort(
        (a, b) =>
          Number(!!a.isProjector) - Number(!!b.isProjector) ||
          Number(quantBits(a.label)) - Number(quantBits(b.label)),
      );
      const weights = quants.filter((q) => !q.isProjector);
      const sizes = weights.map((q) => q.size).filter((s) => s > 0);
      return {
        ...m,
        quants,
        quantizations: [
          ...new Set(weights.map((q) => quantBits(q.label))),
        ].join(', '),
        minSize: sizes.length > 0 ? Math.min(...sizes) : 0,
        maxSize: sizes.length > 0 ? Math.max(...sizes) : 0,
        ...coldStorageRollup(quants),
      };
    })
    .sort((a, b) => compareByRepoName(a.name, b.name));
}

/**
 * Flatten location-filtered `models` into the table's `DisplayRow[]`: a model
 * row per model, then (when expanded) its quant rows or — for a whole-repo
 * model — its repo-file rows, then a split quant's shard rows. Pure: the
 * per-quant cross-location size breakdown (cold storage + each peer, from
 * `peerQuantSizes`/`peerNameByAddr`) decides the effective size and which
 * copies are undersized, and rolls up to the model row's mismatch warning.
 * The React memoization lives in the `useDisplayRows` hook.
 */
export function buildDisplayRows(args: {
  models: ModelRow[];
  expanded: Set<string>;
  repoFiles: Map<string, RepoFile[]>;
  activeLocation: string;
  peerQuantSizes: Map<string, Array<{address: string; size: number}>>;
  peerNameByAddr: Map<string, string>;
}): DisplayRow[] {
  const {
    models,
    expanded,
    repoFiles,
    activeLocation,
    peerQuantSizes,
    peerNameByAddr,
  } = args;
  const out: DisplayRow[] = [];
  // A repo name shared with an adjacent model (the list is sorted by repo name,
  // so collisions are consecutive) needs its org shown to tell the two apart.
  const repoNames = models.map((m) => modelDisplayName(m.name));
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const repoIsAmbiguous =
      repoNames[i] === repoNames[i - 1] || repoNames[i] === repoNames[i + 1];
    const orgSuffix = repoIsAmbiguous ? modelOrg(m.name) : null;
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
        (q) => quantInfo.get(`${m.name}::${q.label}`)?.effectiveSize ?? q.size,
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
      coldIncomplete: [...quantInfo.values()].some((qi) =>
        qi.undersized.has('cold-storage'),
      ),
      ...(repoIssues && repoIssues.length > 0 ? {repoIssues} : {}),
      ...(orgSuffix ? {orgSuffix} : {}),
      ...(m.sidecar ? {sidecar: m.sidecar} : {}),
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
          coldIncomplete: false,
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
        coldIncomplete: info?.undersized.has('cold-storage') ?? false,
        isProjector: q.isProjector,
        precisions: q.precisions,
      });
      // Show individual shards when a split quant is expanded
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
            coldIncomplete: false,
          });
        }
      }
    }
  }
  return out;
}
