import type {AsyncState} from '@/lib/async-state';
import type {Model} from '@/lib/model-types';
import type {RepoFile, RepoFileState} from '@/lib/repo-files';
import {isMmprojFilename} from '@/lib/model-name';
import {ggmlModelVariant} from '@/lib/weight-files';
import {isPickOneSafetensorsRepo} from '@/lib/hf-download';
import {isDiffusersRepo} from '@/lib/diffusers';
import {coldStorageRollup} from '@/lib/cold-storage-rollup';

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
  isProjector?: boolean;
  // Precisions present for a diffusers component variant row (e.g. ['fp16']).
  precisions?: string[];
  // Set on a whole-repo model's per-file child rows (present/missing/invalid).
  fileState?: RepoFileState;
  // Set on a whole-repo model row (depth 0): its invalid + missing files, for
  // the audit hovercard's "why" list and the download action.
  repoIssues?: RepoFile[];
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
  const existingKeys = new Set<string>();
  for (const m of models) {
    for (const q of m.quants) existingKeys.add(`${m.name}::${q.label}`);
  }

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
      for (const f of m.files) {
        const base = f.isSplit ? f.representativeFilename : f.filename;
        const label = isMmprojFilename(base) ? base : f.quant;
        const key = `${m.name}::${label}`;
        if (existingKeys.has(key) || peerOnly.has(key)) continue;
        peerOnly.set(key, {
          modelName: m.name,
          label,
          isProjector: isMmprojFilename(base),
          isSingleFile: !f.isSplit,
          filename: f.isSplit ? null : f.filename,
          displayName: f.isSplit ? f.representativeFilename : f.filename,
          size: f.isSplit ? f.totalSize : f.size,
          paths: f.isSplit ? f.files.map((s) => s.path) : [f.path],
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
    .sort((a, b) => a.name.localeCompare(b.name));
}
