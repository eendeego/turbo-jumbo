import {
  config,
  localModelsDir,
  coldStorageDir,
  lemonadeDir,
  localPeer,
} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {getModelsTableData} from '@/components/models/models-table';
import {HomeClient} from '@/components/home/home-client';

// Server-rendered models table for one location tab. Shared by the catch-all
// page and the hard-navigation Lemonade pages (which render it under the
// already-open download modal).
export function HomeView({location}: {location: string}) {
  const coldModels = scanModels(coldStorageDir);
  const localModels = scanModels(localModelsDir, lemonadeDir);
  const peerConfigs = config.peers.map((p) => ({
    ...p,
    isLocal: p === localPeer,
  }));
  const modelsTableData = getModelsTableData(localModels, coldModels);
  return (
    <HomeClient
      activeLocation={location}
      coldModels={coldModels}
      localModelsPath={localModelsDir ?? null}
      hfTokenSet={!!process.env.HF_TOKEN}
      modelsTableData={modelsTableData}
      peerConfigs={peerConfigs}
      localPeerAddress={localPeer?.address ?? null}
      localPeerModels={localModels}
    />
  );
}
