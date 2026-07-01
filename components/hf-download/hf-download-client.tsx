'use client';

import {useCallback, useMemo} from 'react';
import {useRouter} from 'next/navigation';
import {locationHref, lemonadeHref} from '@/lib/locations';
import type {Peer as PeerConfig} from '@/lib/config';
import {AppShell} from '@astryxdesign/core/AppShell';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {
  LocationTabs,
  type LocationTab,
} from '@/components/models/location-tabs';
import {
  ModelKindTabs,
  type ModelKind,
} from '@/components/models/model-kind-tabs';
import {HfDownloadPicker} from '@/components/hf-download/hf-download-picker';
import {ThemeToggle} from '@/components/theme/theme-toggle';
import {Log} from '@/components/log/log';

/**
 * The Hugging Face download page: a focused task launched from a location's
 * table, reachable only from the All view and the local peer (downloads run
 * locally). Switching location or the Turbo Jumbo/Lemonade tabs navigates
 * away — this page has no state to preserve across those.
 */
export function HfDownloadClient({
  activeLocation,
  localModelsPath,
  hfTokenSet,
  logLevel,
  peerConfigs,
}: {
  activeLocation: string;
  localModelsPath: string;
  hfTokenSet: boolean;
  logLevel: string;
  peerConfigs: PeerConfig[];
}) {
  const router = useRouter();

  const locations: LocationTab[] = useMemo(
    () =>
      peerConfigs.map((p) => ({
        id: p.address,
        label: p.name,
        isLocal: p.isLocal ?? false,
      })),
    [peerConfigs],
  );

  // The HF page is only on All/local; switching location returns to that
  // location's table (it may not have an HF route of its own).
  const handleLocationChange = useCallback(
    (id: string) => {
      router.push(locationHref(id, peerConfigs));
    },
    [router, peerConfigs],
  );

  // Turbo Jumbo returns to this location's table; Lemonade goes to its route.
  const handleKindChange = useCallback(
    (kind: ModelKind) => {
      router.push(
        kind === 'lemonade'
          ? lemonadeHref(activeLocation, peerConfigs)
          : locationHref(activeLocation, peerConfigs),
      );
    },
    [router, activeLocation, peerConfigs],
  );

  const backToTable = useCallback(() => {
    router.push(locationHref(activeLocation, peerConfigs));
  }, [router, activeLocation, peerConfigs]);

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

        <ModelKindTabs value="turbo-jumbo" onChange={handleKindChange} />

        <HfDownloadPicker
          localModelsPath={localModelsPath}
          hfTokenSet={hfTokenSet}
          onClose={backToTable}
        />
      </VStack>

      <Log logLevel={logLevel} />
    </AppShell>
  );
}
