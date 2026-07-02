import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {config, localModelsDir, localPeer} from '@/lib/config';
import {parseRoute} from '@/lib/locations';
import {HomeView} from '@/components/home/home-view';
import {HfDownloadClient} from '@/components/hf-download/hf-download-client';

export function generateMetadata(): Metadata {
  return {title: `Turbo Jumbo - ${localPeer?.name ?? 'unknown'}`};
}

// Reads the live filesystem (local + cold storage), so render per-request
// rather than prerendering at build time.
export const dynamic = 'force-dynamic';

export default async function Home({
  params,
}: {
  params: Promise<{location?: string[]}>;
}) {
  const {location} = await params;
  const route = parseRoute(location, config.peers);
  if (route === null) notFound();
  const {location: activeLocation, view} = route;

  if (view === 'hf') {
    const peerConfigs = config.peers.map((p) => ({
      ...p,
      isLocal: p === localPeer,
    }));
    return (
      <HfDownloadClient
        activeLocation={activeLocation}
        localModelsPath={localModelsDir ?? ''}
        hfTokenSet={!!process.env.HF_TOKEN}
        peerConfigs={peerConfigs}
      />
    );
  }

  // The lemonade view is owned by the explicit /download/lemonade routes (and
  // their @modal interceptors), so this page never receives it.
  return <HomeView location={activeLocation} />;
}
