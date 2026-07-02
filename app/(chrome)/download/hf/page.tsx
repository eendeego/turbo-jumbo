import type {Metadata} from 'next';
import {localPeer} from '@/lib/config';
import {ALL_LOCATION} from '@/lib/locations';
import {HomeView} from '@/components/home/home-view';
import {HfDownloadModalRoute} from '@/components/hf-download/hf-download-modal-route';

export function generateMetadata(): Metadata {
  return {title: `Turbo Jumbo - ${localPeer?.name ?? 'unknown'}`};
}

// Hard navigation (refresh/deep link) to /download/hf: render the All table
// with the download modal already open. Soft navigation from within the app
// is intercepted into the @modal slot instead and never reaches this page.
export const dynamic = 'force-dynamic';

export default function HfDownloadPage() {
  return (
    <>
      <HomeView location={ALL_LOCATION} />
      <HfDownloadModalRoute location={ALL_LOCATION} />
    </>
  );
}
