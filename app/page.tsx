import type {Metadata} from 'next';
import {config, localModelsDir, coldStorageDir, localPeer} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {getModelsTableData} from '@/components/models/models-table';
import {HomeClient} from '@/components/home/home-client';

export function generateMetadata(): Metadata {
  return {title: `Turbo Jumbo - ${localPeer?.name ?? 'unknown'}`};
}

// Reads the live filesystem (local + cold storage), so render per-request
// rather than prerendering at build time.
export const dynamic = 'force-dynamic';

export default function Home() {
  const coldModels = scanModels(coldStorageDir);
  const localModels = scanModels(localModelsDir);
  const modelsTableData = getModelsTableData(localModels, coldModels);
  const peerConfigs = config.peers.map((p) => ({
    ...p,
    isLocal: p === localPeer,
  }));

  return (
    <HomeClient
      coldModels={coldModels}
      localModelsPath={localModelsDir ?? null}
      logLevel={config.log_level ?? 'info'}
      modelsTableData={modelsTableData}
      peerConfigs={peerConfigs}
      localPeerAddress={localPeer?.address ?? null}
      localPeerModels={localModels}
    />
  );
}
