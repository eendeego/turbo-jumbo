'use client';

import {useCallback} from 'react';
import {useRouter} from 'next/navigation';
import {locationHref} from '@/lib/locations';
import type {Peer as PeerConfig} from '@/lib/config';
import {LayoutContent} from '@astryxdesign/core/Layout';
import {HfDownloadPicker} from '@/components/hf-download/hf-download-picker';

/**
 * Content for the Hugging Face download view: a focused task launched from a
 * location's table, reachable only from the All view and the local peer
 * (downloads run locally). The AppShell/TopNav (and global console) come from
 * the route layout; this renders only the picker.
 */
export function HfDownloadClient({
  activeLocation,
  localModelsPath,
  hfTokenSet,
  peerConfigs,
}: {
  activeLocation: string;
  localModelsPath: string;
  hfTokenSet: boolean;
  peerConfigs: PeerConfig[];
}) {
  const router = useRouter();

  const backToTable = useCallback(() => {
    router.push(locationHref(activeLocation, peerConfigs));
  }, [router, activeLocation, peerConfigs]);

  return (
    <LayoutContent padding={5}>
      <HfDownloadPicker
        localModelsPath={localModelsPath}
        hfTokenSet={hfTokenSet}
        onClose={backToTable}
      />
    </LayoutContent>
  );
}
