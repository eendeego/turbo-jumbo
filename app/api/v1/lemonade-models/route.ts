import {lemonadeGgufModels, type LemonadeModel} from '@/lib/lemonade';

// The Lemonade SDK's model catalog, read from the repo's default branch head
// so the list tracks their latest release rather than a pinned revision.
const CATALOG_URL =
  'https://raw.githubusercontent.com/lemonade-sdk/lemonade/main/src/cpp/resources/server_models.json';

// The catalog changes rarely; cache it briefly so reopening the browser
// doesn't refetch from GitHub every time.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: {models: LemonadeModel[]; fetchedAt: number} | null = null;

export async function GET() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return Response.json({models: cache.models});
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
  const models = lemonadeGgufModels(catalog);
  cache = {models, fetchedAt: Date.now()};
  return Response.json({models});
}
