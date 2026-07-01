'use client';

import {useCallback, useMemo} from 'react';
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
import {
  LocationTabs,
  type LocationTab,
} from '@/components/models/location-tabs';
import {AddModelMenu} from '@/components/models/add-model-menu';
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
}: {
  activeLocation: string;
  coldModels: Model[];
  localModelsPath: string;
  hfTokenSet: boolean;
  logLevel: string;
  peerConfigs: PeerConfig[];
  localPeerAddress: string | null;
  localPeerModels: Model[];
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

        {canDownload && (
          <AddModelMenu
            activeLocation={activeLocation}
            peerConfigs={peerConfigs}
          />
        )}

        <LemonadeBrowser
          hfTokenSet={hfTokenSet}
          localModelsPath={localModelsPath}
          inventoryLocations={inventoryLocations}
          canDownload={canDownload}
          onDownloaded={refreshLocalModels}
        />
      </VStack>

      <Log logLevel={logLevel} />
    </AppShell>
  );
}
