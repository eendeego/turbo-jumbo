'use client';

import {useCallback, useEffect, useState} from 'react';
import {useRouter} from 'next/navigation';
import {locationHref} from '@/lib/locations';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models';
import {LEMONADE_CATALOG_URL} from '@/lib/lemonade';
import {downloadTarget} from '@/lib/download-target';
import {LayoutContent} from '@astryxdesign/core/Layout';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {LemonadeBrowser} from '@/components/lemonade/lemonade-browser';
import {useInventoryLocations} from '@/components/models/use-inventory-locations';

/**
 * Content for the "Add from Lemonade" view. The AppShell/TopNav (and global
 * console) come from the route layout; this renders only the heading, catalog
 * note, Back button, and the browser.
 */
export function LemonadeClient({
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

  const backToTable = useCallback(() => {
    router.push(locationHref(activeLocation, peerConfigs));
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

  return (
    <LayoutContent padding={5}>
      <VStack gap={4}>
        <HStack vAlign="center">
          <StackItem size="fill">
            <Heading level={2}>Add from Lemonade</Heading>
          </StackItem>
          <Button
            label="Back"
            variant="secondary"
            size="sm"
            onClick={backToTable}
          />
        </HStack>

        {/* Where the catalog driving this page comes from. */}
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
    </LayoutContent>
  );
}
