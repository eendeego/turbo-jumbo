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
import {getModelsTableData} from '@/components/models/models-table';
import {HomeClient} from '@/components/home/home-client';
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

  const coldModels = scanModels(coldStorageDir);
  const localModels = scanModels(localModelsDir, lemonadeDir);
  const peerConfigs = config.peers.map((p) => ({
    ...p,
    isLocal: p === localPeer,
  }));

  if (view === 'hf') {
    return (
      <HfDownloadClient
        activeLocation={activeLocation}
        localModelsPath={localModelsDir ?? ''}
        hfTokenSet={!!process.env.HF_TOKEN}
        logLevel={config.log_level ?? 'info'}
        peerConfigs={peerConfigs}
      />
    );
  }

  if (view === 'lemonade') {
    // Lemonade's own model cache lives outside the managed storage; scan it so
    // the Lemonade browser can flag catalog entries already present there.
    const lemonadeCacheModels = lemonadeDir ? scanModels(lemonadeDir) : [];
    return (
      <LemonadeClient
        activeLocation={activeLocation}
        coldModels={coldModels}
        localModelsPath={localModelsDir ?? ''}
        hfTokenSet={!!process.env.HF_TOKEN}
        logLevel={config.log_level ?? 'info'}
        peerConfigs={peerConfigs}
        localPeerAddress={localPeer?.address ?? null}
        localPeerModels={localModels}
        lemonadeCacheModels={lemonadeCacheModels}
      />
    );
  }

  const modelsTableData = getModelsTableData(localModels, coldModels);
  return (
    <HomeClient
      activeLocation={activeLocation}
      coldModels={coldModels}
      localModelsPath={localModelsDir ?? null}
      hfTokenSet={!!process.env.HF_TOKEN}
      logLevel={config.log_level ?? 'info'}
      modelsTableData={modelsTableData}
      peerConfigs={peerConfigs}
      localPeerAddress={localPeer?.address ?? null}
      localPeerModels={localModels}
    />
  );
}
