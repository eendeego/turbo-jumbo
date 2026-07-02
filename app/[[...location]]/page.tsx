import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {
  config,
  localModelsDir,
  coldStorageDir,
  lemonadeDir,
  localPeer,
} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {parseRoute} from '@/lib/locations';
import {HomeView} from '@/components/home/home-view';
import {LemonadeClient} from '@/components/lemonade/lemonade-client';
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

  if (view === 'lemonade') {
    const coldModels = scanModels(coldStorageDir);
    const localModels = scanModels(localModelsDir, lemonadeDir);
    const peerConfigs = config.peers.map((p) => ({
      ...p,
      isLocal: p === localPeer,
    }));
    // Lemonade's own model cache lives outside the managed storage; scan it so
    // the Lemonade browser can flag catalog entries already present there.
    const lemonadeCacheModels = lemonadeDir ? scanModels(lemonadeDir) : [];
    return (
      <LemonadeClient
        activeLocation={activeLocation}
        coldModels={coldModels}
        localModelsPath={localModelsDir ?? ''}
        hfTokenSet={!!process.env.HF_TOKEN}
        peerConfigs={peerConfigs}
        localPeerAddress={localPeer?.address ?? null}
        localPeerModels={localModels}
        lemonadeCacheModels={lemonadeCacheModels}
      />
    );
  }

  return <HomeView location={activeLocation} />;
}
