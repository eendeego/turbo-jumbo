import {useMemo} from 'react';
import type {Peer as PeerConfig} from '@/lib/config';
import type {PeerModels} from '@/components/peers/peer';
import type {RepoFile} from '@/lib/repo-files';
import {fileBasename, fileJoinKey, peerFileKeys} from '@/lib/peer-paths';
import {isDiffusersRepo} from '@/lib/diffusers';
import {coldStorageRollup} from '@/lib/cold-storage-rollup';
import {
  augmentWithPeerOnlyQuants,
  buildDisplayRows,
  type DisplayRow,
  type ModelRow,
} from '@/lib/model-row';

/**
 * The table's data-derivation pipeline: turn the location-filtered models, the
 * peer inventories and the current expansion into the `DisplayRow[]` the table
 * renders, plus the lookups its header/cells need. Memoized so row objects keep
 * their identity across unrelated re-renders (Table's per-row memo bails out via
 * shallow compare otherwise). The pure row assembly lives in
 * `lib/model-row.buildDisplayRows`; this hook is the React glue.
 */
export function useDisplayRows({
  models,
  peers,
  peerModels,
  activeLocation,
  expanded,
  repoFiles,
}: {
  models: ModelRow[];
  peers: PeerConfig[];
  peerModels: Map<string, PeerModels>;
  activeLocation: string;
  expanded: Set<string>;
  repoFiles: Map<string, RepoFile[]>;
}): {
  rows: DisplayRow[];
  peerKeys: Map<string, Set<string>>;
  allVisiblePaths: string[];
  allExpandableKeys: string[];
} {
  // Lookup: peerAddress -> Set<file join key>. Files are matched across hosts by
  // key because model names are derived per host and can disagree for the same
  // file (see lib/peer-paths.ts).
  const peerKeys = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [address, lo] of peerModels) {
      if (lo.type !== 'value') continue;
      map.set(address, peerFileKeys(lo.value));
    }
    return map;
  }, [peerModels]);

  // Lookup: "modelName::filename" -> [{address, size}] across all peers (split
  // groups summed), to flag copies whose sizes disagree by location.
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

  // Synthesize rows for quants that exist only on peers — absent from local and
  // cold storage — so the table shows everything reachable.
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

  const rows = useMemo(
    () =>
      buildDisplayRows({
        models: effectiveModels,
        expanded,
        repoFiles,
        activeLocation,
        peerQuantSizes,
        peerNameByAddr,
      }),
    [
      effectiveModels,
      expanded,
      repoFiles,
      activeLocation,
      peerQuantSizes,
      peerNameByAddr,
    ],
  );

  // Every selectable file path in the current tab's view, for the select-all
  // header checkbox.
  const allVisiblePaths = useMemo(
    () => effectiveModels.flatMap((m) => m.quants.flatMap((q) => q.paths)),
    [effectiveModels],
  );

  // Everything the current view can expand: each model, and each split quant's
  // shard group. Drives the expand-all chevron in the Model header.
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

  return {rows, peerKeys, allVisiblePaths, allExpandableKeys};
}
