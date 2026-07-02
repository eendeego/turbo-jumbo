import {localModelsDir, lemonadeDir} from '@/lib/config';
import {
  catalogRepoIds,
  parseLemonade,
  LEMONADE_CATALOG_URL,
} from '@/lib/lemonade/lemonade';
import {
  previewLemonadeSync,
  syncLemonadeToTurboJumbo,
  type LemonadeSyncPreview,
  type SyncModelResult,
} from '@/lib/lemonade/lemonade-sync';

// Shared Lemonade↔Turbo Jumbo consolidation handlers. The work always runs on
// the machine whose config is loaded here, so both the local route and the
// per-peer route (its local branch) call these against their own config —
// a remote peer consolidates its own Lemonade cache into its own store.

// The HuggingFace repos Lemonade's catalog references — best-effort, since the
// materialize pass is a bonus on top of cache consolidation. An unreachable
// catalog just yields no materialize candidates.
async function fetchCatalogRepoIds(): Promise<string[]> {
  try {
    const res = await fetch(LEMONADE_CATALOG_URL, {
      headers: {'User-Agent': 'tj/1.0'},
    });
    if (!res.ok) return [];
    return catalogRepoIds(parseLemonade(await res.json()));
  } catch {
    return [];
  }
}

// Preview the changes a sync would make (read-only). Returns an empty preview
// when Lemonade is not configured on this machine.
export async function previewSync(): Promise<{preview: LemonadeSyncPreview[]}> {
  if (!localModelsDir || !lemonadeDir) return {preview: []};
  const repoIds = await fetchCatalogRepoIds();
  const preview = await previewLemonadeSync(
    localModelsDir,
    lemonadeDir,
    repoIds,
  );
  return {preview};
}

// Execute the sync. Returns null when Lemonade is not configured so callers can
// surface the right error.
export async function runSync(): Promise<{results: SyncModelResult[]} | null> {
  if (!localModelsDir || !lemonadeDir) return null;
  const repoIds = await fetchCatalogRepoIds();
  const results = await syncLemonadeToTurboJumbo(
    localModelsDir,
    lemonadeDir,
    repoIds,
  );
  return {results};
}
