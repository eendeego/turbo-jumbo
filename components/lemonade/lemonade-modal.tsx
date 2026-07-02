'use client';

import {useCallback, useEffect, useState} from 'react';
import {usePathname, useRouter} from 'next/navigation';
import {locationHref} from '@/lib/storage/locations';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models/models';
import {LEMONADE_CATALOG_URL} from '@/lib/lemonade/lemonade';
import {downloadTarget} from '@/lib/hf/download-target';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Link} from '@astryxdesign/core/Link';
import {LemonadeBrowser} from '@/components/lemonade/lemonade-browser';
import {useInventoryLocations} from '@/components/models/use-inventory-locations';

/**
 * The "Add from Lemonade" download modal. Routed: soft navigation to
 * /download/lemonade (or /<peer>/download/lemonade) intercepts into the
 * @modal slot over the current table; hard navigation renders it over a
 * freshly rendered table. Closing navigates back to the location's table.
 */
export function LemonadeModal({
  activeLocation,
  coldModels,
  localModelsPath,
  hfTokenSet,
  peerConfigs,
  localPeerAddress,
  localPeerModels,
  lemonadeCacheModels: lemonadeCacheModelsProp,
}: {
  activeLocation: string;
  coldModels: Model[];
  localModelsPath: string;
  hfTokenSet: boolean;
  peerConfigs: PeerConfig[];
  localPeerAddress: string | null;
  localPeerModels: Model[];
  lemonadeCacheModels: Model[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const {handleModelsRefreshed, inventoryLocations} = useInventoryLocations({
    peerConfigs,
    localPeerAddress,
    localPeerModels,
    coldModels,
  });

  // Re-scan the local peer after a download so its status markers update.
  const refreshLocalModels = useCallback(async () => {
    const local = peerConfigs.find((p) => p.isLocal);
    if (!local) return;
    try {
      const res = await fetch(
        `/api/v1/peers/${encodeURIComponent(local.name)}/models`,
      );
      if (!res.ok) return;
      const models = (await res.json()) as Model[];
      handleModelsRefreshed(local.address, models);
    } catch {
      /* best-effort: the periodic poll will catch up */
    }
  }, [peerConfigs, handleModelsRefreshed]);

  // Models in Lemonade's own cache directory, seeded from the server scan and
  // re-fetched after a download so the browser's cache token stays current.
  const [lemonadeCacheModels, setLemonadeCacheModels] = useState(
    lemonadeCacheModelsProp,
  );
  const [prevCacheProp, setPrevCacheProp] = useState(lemonadeCacheModelsProp);
  if (prevCacheProp !== lemonadeCacheModelsProp) {
    setPrevCacheProp(lemonadeCacheModelsProp);
    setLemonadeCacheModels(lemonadeCacheModelsProp);
  }
  const refreshLemonadeCache = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/lemonade-cache');
      if (!res.ok) return;
      setLemonadeCacheModels((await res.json()) as Model[]);
    } catch {
      /* best-effort: the next page render reseeds from the server scan */
    }
  }, []);
  // Repo ids whose local copy is present but incomplete (missing files a full
  // download would include). Downloads land locally, so flag against the local
  // store; re-fetched after each download.
  const [incompleteRepos, setIncompleteRepos] = useState<Set<string>>(
    new Set(),
  );
  const refreshIncomplete = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/local-models/incomplete');
      if (!res.ok) return;
      const data = (await res.json()) as {incomplete?: string[]};
      setIncompleteRepos(new Set(data.incomplete ?? []));
    } catch {
      /* best-effort: the markers just won't show */
    }
  }, []);
  useEffect(() => {
    (async () => {
      await refreshIncomplete();
    })();
  }, [refreshIncomplete]);

  // A download can land in managed storage or the Lemonade cache, and changes
  // completeness — refresh all three when one finishes.
  const onDownloaded = useCallback(async () => {
    await Promise.all([
      refreshLocalModels(),
      refreshLemonadeCache(),
      refreshIncomplete(),
    ]);
  }, [refreshLocalModels, refreshLemonadeCache, refreshIncomplete]);

  // Closing navigates to the location's table. replace (not push/back) behaves
  // identically for soft and hard navigation and leaves no modal entry in
  // history, so Back after closing doesn't reopen it.
  const close = useCallback(() => {
    router.replace(locationHref(activeLocation, peerConfigs));
  }, [router, activeLocation, peerConfigs]);

  // Where the download runs: the All tab and the local peer download on this
  // machine; a remote peer's tab downloads on that peer via the proxy.
  const target = downloadTarget(activeLocation, peerConfigs, localModelsPath);
  // The inventory whose presence decides which files to skip: the machine the
  // download will run on (All → the local peer), identified by peer name to
  // match the InventoryLocation entries.
  const targetPeerAddress =
    activeLocation === 'all' ? localPeerAddress : activeLocation;
  const targetName =
    peerConfigs.find((p) => p.address === targetPeerAddress)?.name ?? null;
  // Any peer tab (and All) can download now; only Cold Storage has no Lemonade
  // view, and it never reaches here.
  const canDownload =
    activeLocation === 'all' ||
    peerConfigs.some((p) => p.address === activeLocation);

  // On soft navigation away (e.g. browser Back while open) Next keeps the
  // unmatched @modal slot's previous state mounted, so gate on the URL: only
  // render while it is still a Lemonade download route.
  if (!pathname.endsWith('/download/lemonade')) return null;

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
          title="Add from Lemonade"
          onOpenChange={(open) => {
            if (!open) close();
          }}
        />

        {/* Where the catalog driving this modal comes from. */}
        <Text type="supporting">
          Catalog:{' '}
          <Link href={LEMONADE_CATALOG_URL} isExternalLink>
            {LEMONADE_CATALOG_URL.split('/').pop()}
          </Link>
        </Text>

        <LemonadeBrowser
          hfTokenSet={hfTokenSet}
          target={target}
          targetName={targetName}
          inventoryLocations={inventoryLocations}
          lemonadeCacheModels={lemonadeCacheModels}
          incompleteRepos={incompleteRepos}
          canDownload={canDownload}
          onDownloaded={onDownloaded}
        />
      </VStack>
    </Dialog>
  );
}
