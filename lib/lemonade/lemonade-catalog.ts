import type {
  Checkpoint,
  LemonadeComponent,
  LemonadeModel,
  OmniCollection,
} from '@/lib/lemonade/lemonade';
import type {FlmModel} from '@/lib/lemonade/flm';

// A row in a modality section: a single-file GGUF model or a standalone
// non-llamacpp model (rendered as a component).
export type CatalogRow =
  | {kind: 'model'; model: LemonadeModel}
  | {kind: 'component'; component: LemonadeComponent};

export type HfFile = {path: string; size: number};

// What's currently picked for download: a standalone model, one component of a
// collection, a whole collection, or a live Lemonade server's FLM model.
export type Selection =
  | {kind: 'model'; model: LemonadeModel}
  | {kind: 'standalone'; component: LemonadeComponent}
  | {kind: 'component'; collectionName: string; component: LemonadeComponent}
  | {kind: 'collection'; collection: OmniCollection}
  | {kind: 'flm'; model: FlmModel};

export function selectionKey(s: Selection): string {
  if (s.kind === 'model') return `model:${s.model.name}`;
  if (s.kind === 'standalone') return `standalone:${s.component.name}`;
  if (s.kind === 'collection') return `coll:${s.collection.name}`;
  if (s.kind === 'flm') return `flm:${s.model.name}`;
  return `comp:${s.collectionName}:${s.component.name}`;
}

export function selectionLabel(s: Selection): {title: string; sizeGb: number} {
  if (s.kind === 'model') return {title: s.model.name, sizeGb: s.model.sizeGb};
  if (s.kind === 'collection')
    return {title: s.collection.name, sizeGb: s.collection.sizeGb};
  if (s.kind === 'flm') return {title: s.model.name, sizeGb: s.model.sizeGb};
  return {title: s.component.name, sizeGb: s.component.sizeGb};
}

export const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

// Whether any of a model's repos is present-but-incomplete locally.
export const checkpointsIncomplete = (
  checkpoints: Checkpoint[],
  incompleteRepos: Set<string>,
) => checkpoints.some((cp) => incompleteRepos.has(cp.repoId));

export function formatGb(sizeGb: number): string {
  return `${sizeGb.toFixed(2)} GB`;
}
