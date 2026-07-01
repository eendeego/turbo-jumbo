import type {Model} from './models';
import type {ModelRow} from '@/components/models/models-table-client';

// A file's basename is the only identity both hosts agree on: model names are
// derived per host (the sidecar's org/repo when one exists, otherwise the
// filename), so the same file can be named "Jan-nano-128k" on one host and
// "unsloth/Jan-nano-128k-GGUF" on the other — e.g. after an audit Fix wrote a
// sidecar and relocated it on one side only.
export const fileBasename = (p: string) => p.split('/').pop() ?? p;

/**
 * Every file basename present on the peer (shards count individually). The
 * models table joins on these to decide which local rows the peer has — both
 * for the presence tokens and for filtering rows on a peer's tab.
 */
export function peerFileBasenames(models: Model[]): Set<string> {
  const names = new Set<string>();
  for (const m of models) {
    for (const f of m.files) {
      if (f.isSplit) {
        for (const s of f.files) names.add(fileBasename(s.path));
      } else {
        names.add(fileBasename(f.path));
      }
    }
  }
  return names;
}

/**
 * Replace each quant's paths with the peer's own paths for that quant. File
 * operations on a peer tab (audit, copy, delete) resolve paths on the peer,
 * whose storage layout can differ from the local one — the same file can sit
 * at a bare path on one host and under <repoId>/ on another.
 *
 * Files are joined by basename (see above), the same identity the peer
 * presence tokens use, so every row visible on a peer tab gets mapped. Quants
 * the peer doesn't have keep their local paths; they're filtered off peer
 * tabs anyway.
 */
export function withPeerPaths(
  models: ModelRow[],
  peerModels: Model[],
): ModelRow[] {
  const byBasename = new Map<string, string[]>();
  for (const m of peerModels) {
    for (const f of m.files) {
      const paths = f.isSplit ? f.files.map((s) => s.path) : [f.path];
      for (const p of paths) {
        const prev = byBasename.get(fileBasename(p));
        if (prev) {
          prev.push(p);
        } else {
          byBasename.set(fileBasename(p), [p]);
        }
      }
    }
  }
  return models.map((m) => ({
    ...m,
    quants: m.quants.map((q) => {
      const peerPaths = q.paths.flatMap(
        (p) => byBasename.get(fileBasename(p)) ?? [],
      );
      return peerPaths.length > 0 ? {...q, paths: peerPaths} : q;
    }),
  }));
}
