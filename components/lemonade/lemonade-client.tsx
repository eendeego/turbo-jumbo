'use client';

import {useCallback, useEffect, useMemo, useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  locationHref,
  lemonadeHref,
  COLD_STORAGE_LOCATION,
} from '@/lib/locations';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models';
import {AppShell} from '@astryxdesign/core/AppShell';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {
  LocationTabs,
  type LocationTab,
} from '@/components/models/location-tabs';
import {LemonadeBrowser} from '@/components/lemonade/lemonade-browser';
import {ThemeToggle} from '@/components/theme/theme-toggle';
import {Log} from '@/components/log/log';
import {useInventoryLocations} from '@/components/models/use-inventory-locations';

export function LemonadeClient({
  activeLocation,
  coldModels,
  localModelsPath,
  hfTokenSet,
  logLevel,
  peerConfigs,
  localPeerAddress,
  localPeerModels,
  lemonadeCacheModels: lemonadeCacheModelsProp,
}: {
  activeLocation: string;
  coldModels: Model[];
  localModelsPath: string;
  hfTokenSet: boolean;
  logLevel: string;
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

  const locations: LocationTab[] = useMemo(
    () =>
      peerConfigs.map((p) => ({
        id: p.address,
        label: p.name,
        isLocal: p.isLocal ?? false,
      })),
    [peerConfigs],
  );

  // Switching location stays in Lemonade, except Cold Storage (no Lemonade
  // there) which drops to its table.
  const handleLocationChange = useCallback(
    (id: string) => {
      router.push(
        id === COLD_STORAGE_LOCATION
          ? locationHref(id, peerConfigs)
          : lemonadeHref(id, peerConfigs),
      );
    },
    [router, peerConfigs],
  );

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

  // Downloads run only on the local machine, so the All and local-peer views
  // can download; a remote peer's view is browse-only.
  const canDownload =
    activeLocation === 'all' || activeLocation === localPeerAddress;

  return (
    <AppShell contentPadding={5} height="auto">
      <VStack gap={6}>
        <HStack vAlign="center">
          <StackItem size="fill">
            <Heading level={1}>Turbo Jumbo</Heading>
          </StackItem>
          <ThemeToggle />
        </HStack>

        <LocationTabs
          locations={locations}
          activeLocation={activeLocation}
          onLocationChange={handleLocationChange}
        />

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

        <LemonadeBrowser
          hfTokenSet={hfTokenSet}
          localModelsPath={localModelsPath}
          inventoryLocations={inventoryLocations}
          lemonadeCacheModels={lemonadeCacheModels}
          incompleteRepos={incompleteRepos}
          canDownload={canDownload}
          onDownloaded={onDownloaded}
        />
      </VStack>

      <Log logLevel={logLevel} />
    </AppShell>
  );
}
