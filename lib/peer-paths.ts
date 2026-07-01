import type {Model} from './models';
import type {ModelRow} from '@/components/models/models-table-client';

/**
 * Replace each quant's paths with the peer's own paths for that quant. File
 * operations on a peer tab (audit, copy, delete) resolve paths on the peer,
 * whose storage layout can differ from the local one — the same file can sit
 * at a bare path on one host and under <repoId>/ on another. Quants the peer
 * doesn't have keep their local paths; they're filtered off peer tabs anyway.
 *
 * Quants are joined by model name + quant label, the same key the peer
 * presence tokens use, so every row visible on a peer tab gets mapped.
 */
export function withPeerPaths(
  models: ModelRow[],
  peerModels: Model[],
): ModelRow[] {
  const byQuant = new Map<string, string[]>();
  for (const m of peerModels) {
    for (const f of m.files) {
      const key = `${m.name}::${f.quant}`;
      const paths = f.isSplit ? f.files.map((s) => s.path) : [f.path];
      const prev = byQuant.get(key);
      byQuant.set(key, prev ? [...prev, ...paths] : paths);
    }
  }
  return models.map((m) => ({
    ...m,
    quants: m.quants.map((q) => {
      const peerPaths = byQuant.get(`${m.name}::${q.label}`);
      return peerPaths ? {...q, paths: peerPaths} : q;
    }),
  }));
}
