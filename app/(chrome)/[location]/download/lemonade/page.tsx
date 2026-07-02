import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {config, localPeer} from '@/lib/config';
import {resolveLocation, COLD_STORAGE_LOCATION} from '@/lib/storage/locations';
import {HomeView} from '@/components/home/home-view';
import {LemonadeModalRoute} from '@/components/lemonade/lemonade-modal-route';

export function generateMetadata(): Metadata {
  return {title: `Turbo Jumbo - ${localPeer?.name ?? 'unknown'}`};
}

// Hard navigation (refresh/deep link) to /<peer>/download/lemonade: render
// that peer's table with the download modal already open.
export const dynamic = 'force-dynamic';

export default async function PeerLemonadeDownloadPage({
  params,
}: {
  params: Promise<{location: string}>;
}) {
  const {location: slug} = await params;
  const location = resolveLocation([slug], config.peers);
  // Cold Storage has no Lemonade view; unknown slugs 404 (parity with the
  // old parseRoute behavior).
  if (location === null || location === COLD_STORAGE_LOCATION) notFound();
  return (
    <>
      <HomeView location={location} />
      <LemonadeModalRoute location={location} />
    </>
  );
}
