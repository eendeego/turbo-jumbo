import {config} from '@/lib/config';
import {resolveLocation, COLD_STORAGE_LOCATION} from '@/lib/storage/locations';
import {LemonadeModalRoute} from '@/components/lemonade/lemonade-modal-route';

// Soft navigation to /<peer>/download/lemonade. Invalid locations render no
// modal — the app never links to them, and a hard navigation 404s on the
// real route instead.
export const dynamic = 'force-dynamic';

export default async function InterceptedPeerLemonadePage({
  params,
}: {
  params: Promise<{location: string}>;
}) {
  const {location: slug} = await params;
  const location = resolveLocation([slug], config.peers);
  if (location === null || location === COLD_STORAGE_LOCATION) return null;
  return <LemonadeModalRoute location={location} />;
}
