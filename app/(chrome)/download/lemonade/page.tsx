import type {Metadata} from 'next';
import {localPeer} from '@/lib/config';
import {ALL_LOCATION} from '@/lib/storage/locations';
import {HomeView} from '@/components/home/home-view';
import {LemonadeModalRoute} from '@/components/lemonade/lemonade-modal-route';

export function generateMetadata(): Metadata {
  return {title: `Turbo Jumbo - ${localPeer?.name ?? 'unknown'}`};
}

// Hard navigation (refresh/deep link) to /download/lemonade: render the All
// table with the download modal already open. Soft navigation from within the
// app is intercepted into the @modal slot instead and never reaches this page.
export const dynamic = 'force-dynamic';

export default function LemonadeDownloadPage() {
  return (
    <>
      <HomeView location={ALL_LOCATION} />
      <LemonadeModalRoute location={ALL_LOCATION} />
    </>
  );
}
