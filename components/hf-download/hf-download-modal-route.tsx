import {config, localModelsDir, localPeer} from '@/lib/config';
import {HfDownloadModal} from '@/components/hf-download/hf-download-modal';

// Server side of the HF download modal. Unlike Lemonade it needs no
// filesystem scans — only config. Shared by the intercepted (soft-nav) pages
// in the @modal slot and the real (hard-nav) pages.
export function HfDownloadModalRoute({location}: {location: string}) {
  const peerConfigs = config.peers.map((p) => ({
    ...p,
    isLocal: p === localPeer,
  }));
  return (
    <HfDownloadModal
      activeLocation={location}
      localModelsPath={localModelsDir ?? ''}
      hfTokenSet={!!process.env.HF_TOKEN}
      peerConfigs={peerConfigs}
    />
  );
}
