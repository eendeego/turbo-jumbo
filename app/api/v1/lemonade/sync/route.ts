import {NextResponse} from 'next/server';
import {localModelsDir, lemonadeDir} from '@/lib/config';
import {
  catalogRepoIds,
  parseLemonade,
  LEMONADE_CATALOG_URL,
} from '@/lib/lemonade';
import {
  previewLemonadeSync,
  syncLemonadeToTurboJumbo,
} from '@/lib/lemonade-sync';

// Sync Lemonade and Turbo Jumbo: GET previews the changes (read-only); POST
// executes them. Pass 1 consolidates Lemonade's on-disk cache into Turbo Jumbo
// (move + deduplicate); pass 2 mirrors catalog models Turbo Jumbo already holds
// back into Lemonade's cache as symlinks.

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

export async function GET() {
  if (!localModelsDir || !lemonadeDir) return NextResponse.json({preview: []});
  const repoIds = await fetchCatalogRepoIds();
  const preview = await previewLemonadeSync(
    localModelsDir,
    lemonadeDir,
    repoIds,
  );
  return NextResponse.json({preview});
}

export async function POST() {
  if (!localModelsDir || !lemonadeDir)
    return new Response('Lemonade is not configured', {status: 400});
  const repoIds = await fetchCatalogRepoIds();
  const results = await syncLemonadeToTurboJumbo(
    localModelsDir,
    lemonadeDir,
    repoIds,
  );
  return NextResponse.json({results});
}
