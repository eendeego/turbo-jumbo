// Pure model types and helpers shared by server-only scanning code
// (lib/models.ts) and client components. Must stay free of Node imports
// (fs, path) since client bundles pull in anything this module imports.

export interface SingleFile {
  isSplit: false;
  filename: string;
  path: string; // relative from storage root, for API calls
  quant: string;
  size: number;
  missing: boolean;
}

// One shard of a split (sharded) quantization.
export interface Shard {
  path: string; // relative from storage root, for API calls
  size: number;
}

// A peer running an older version may still report shards as bare path strings
// rather than {path, size} objects. These normalize either shape so the UI and
// size accounting don't crash on cross-version data.
export function shardPath(f: Shard | string): string {
  return typeof f === 'string' ? f : (f?.path ?? '');
}
export function shardSize(f: Shard | string): number {
  return typeof f === 'string' ? 0 : (f?.size ?? 0);
}

export interface SplitGroup {
  isSplit: true;
  representativeFilename: string;
  files: Shard[]; // present shards, for API calls
  quant: string;
  totalShards: number;
  presentShards: number;
  missingIndices: number[];
  totalSize: number;
}

export type ModelFile = SingleFile | SplitGroup;

export interface Model {
  name: string;
  files: ModelFile[];
}
