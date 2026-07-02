import {
  config,
  localModelsDir,
  coldStorageDir,
  lemonadeDir,
  localPeer,
} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {LemonadeModal} from '@/components/lemonade/lemonade-modal';

// Server side of the Lemonade download modal: scans the stores the modal
// needs and renders it. Shared by the intercepted (soft-nav) pages in the
// @modal slot and the real (hard-nav) pages, so the route files stay thin.
export function LemonadeModalRoute({location}: {location: string}) {
  const coldModels = scanModels(coldStorageDir);
  const localModels = scanModels(localModelsDir, lemonadeDir);
  // Lemonade's own model cache lives outside the managed storage; scan it so
  // the Lemonade browser can flag catalog entries already present there.
  const lemonadeCacheModels = lemonadeDir ? scanModels(lemonadeDir) : [];
  const peerConfigs = config.peers.map((p) => ({
    ...p,
    isLocal: p === localPeer,
  }));
  return (
    <LemonadeModal
      activeLocation={location}
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
