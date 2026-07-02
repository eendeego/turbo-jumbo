'use client';

import {useCallback} from 'react';
import {usePathname, useRouter} from 'next/navigation';
import {locationHref} from '@/lib/locations';
import type {Peer as PeerConfig} from '@/lib/config';
import {downloadTarget} from '@/lib/download-target';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {VStack} from '@astryxdesign/core/Stack';
import {HfDownloadPicker} from '@/components/hf-download/hf-download-picker';

/**
 * The "Add from Hugging Face" download modal. Routed like the Lemonade one:
 * soft navigation to /download/hf (or /<peer>/download/hf) intercepts into
 * the @modal slot over the current table; hard navigation renders it over a
 * freshly rendered table. Closing navigates back to the location's table.
 */
export function HfDownloadModal({
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
  const pathname = usePathname();

  // Closing navigates to the location's table. replace (not push/back) behaves
  // identically for soft and hard navigation and leaves no modal entry in
  // history, so Back after closing doesn't reopen it.
  const close = useCallback(() => {
    router.replace(locationHref(activeLocation, peerConfigs));
  }, [router, activeLocation, peerConfigs]);

  // Where the download runs: the All tab and the local peer download on this
  // machine; a remote peer's tab downloads on that peer via the proxy.
  const target = downloadTarget(activeLocation, peerConfigs, localModelsPath);

  // On soft navigation away (e.g. browser Back while open) Next keeps the
  // unmatched @modal slot's previous state mounted, so gate on the URL: only
  // render while it is still an HF download route.
  if (!pathname.endsWith('/download/hf')) return null;

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      width="min(1100px, 92vw)"
      maxHeight="85vh"
      purpose="form"
    >
      <VStack gap={4}>
        <DialogHeader
          title="Add from Hugging Face"
          onOpenChange={(open) => {
            if (!open) close();
          }}
        />
        <HfDownloadPicker target={target} hfTokenSet={hfTokenSet} />
      </VStack>
    </Dialog>
  );
}
