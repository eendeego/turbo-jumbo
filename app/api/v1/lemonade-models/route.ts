import {
  collectionFromManifest,
  parseLemonade,
  type LemonadeComponent,
  type LemonadeModel,
  type OmniCollection,
  type OmniManifestRef,
} from '@/lib/lemonade';

// The Lemonade SDK's model catalog, read from the repo's default branch head
// so the list tracks their latest release rather than a pinned revision.
const CATALOG_URL =
  'https://raw.githubusercontent.com/lemonade-sdk/lemonade/main/src/cpp/resources/server_models.json';

// The catalog changes rarely; cache it briefly so reopening the browser
// doesn't refetch from GitHub (and re-fetch every omni manifest) every time.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: {
  models: LemonadeModel[];
  extraModels: LemonadeComponent[];
  collections: OmniCollection[];
  fetchedAt: number;
} | null = null;

// An omni collection whose components live in a manifest JSON inside its HF
// repo (named `<repo>.json`). Fetch and resolve it; on any failure still return
// the collection header so it renders, just without its component breakdown.
async function fetchManifestCollection(
  ref: OmniManifestRef,
  downloadableNames: Set<string>,
): Promise<OmniCollection> {
  const file = `${ref.repoId.split('/').pop()}.json`;
  try {
    const res = await fetch(
      `https://huggingface.co/${ref.repoId}/resolve/main/${encodeURIComponent(file)}`,
      {headers: {'User-Agent': 'tj/1.0'}},
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return collectionFromManifest(ref, await res.json(), downloadableNames);
  } catch {
    return collectionFromManifest(ref, null, downloadableNames);
  }
}

export async function GET() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return Response.json({
      models: cache.models,
      extraModels: cache.extraModels,
      collections: cache.collections,
    });
  }
  let res: Response;
  try {
    res = await fetch(CATALOG_URL, {headers: {'User-Agent': 'tj/1.0'}});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json(
      {error: `Couldn't reach the Lemonade catalog: ${msg}`},
      {status: 502},
    );
  }
  if (!res.ok) {
    return Response.json(
      {error: `Lemonade catalog fetch failed: ${res.status} ${res.statusText}`},
      {status: 502},
    );
  }
  let catalog: unknown;
  try {
    catalog = await res.json();
  } catch {
    return Response.json(
      {error: 'Lemonade catalog is not valid JSON.'},
      {status: 502},
    );
  }
  const {
    models,
    extraModels,
    collections: inlineCollections,
    manifestRefs,
  } = parseLemonade(catalog);
  const downloadableNames = new Set(models.map((m) => m.name));
  const manifestCollections = await Promise.all(
    manifestRefs.map((ref) => fetchManifestCollection(ref, downloadableNames)),
  );
  const collections = [...inlineCollections, ...manifestCollections];
  cache = {models, extraModels, collections, fetchedAt: Date.now()};
  return Response.json({models, extraModels, collections});
}
