'use client';

import {useCallback, useMemo, useState} from 'react';
import {useRouter, usePathname} from 'next/navigation';
import {AppShell} from '@astryxdesign/core/AppShell';
import {TopNav, TopNavHeading} from '@astryxdesign/core/TopNav';
import {NavIcon} from '@astryxdesign/core/NavIcon';
import {HStack} from '@astryxdesign/core/Stack';
import {Button} from '@astryxdesign/core/Button';
import {CubeIcon} from '@heroicons/react/24/outline';
import type {Peer as PeerConfig} from '@/lib/config';
import {locationHref, parseRoute, ALL_LOCATION} from '@/lib/locations';
import {
  LocationTabs,
  type LocationTab,
} from '@/components/models/location-tabs';
import {usePeerStatus} from '@/components/models/use-peer-status';
import {AddModelMenu} from '@/components/models/add-model-menu';
import {ThemeToggle} from '@/components/theme/theme-toggle';
import {Log} from '@/components/log/log';
import {LemonadeSyncModal} from '@/components/lemonade/lemonade-sync-modal';
import {ConsoleProvider} from '@/components/chrome/console-context';

// The persistent app shell: TopNav (identity, location tabs, download actions,
// theme) plus the single global console. Rendered by the route layout, so it
// stays mounted while the page content swaps between the table and the Add-model
// (HF/Lemonade) views.
export function AppChrome({
  peers,
  logLevel,
  children,
}: {
  peers: PeerConfig[];
  logLevel: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // The active location follows the URL (the layout is static), so the tabs
  // track navigation regardless of layout re-render timing.
  const activeLocation = useMemo(() => {
    const segments = pathname.split('/').filter(Boolean);
    return parseRoute(segments, peers)?.location ?? ALL_LOCATION;
  }, [pathname, peers]);
  // "Consolidate" runs on a single machine, so it shows on any peer tab (it
  // runs on that peer) but not on All.
  const consolidatePeer = peers.find((p) => p.address === activeLocation);
  // "Add model" works on any peer tab (downloads run on that peer) and on All.
  const canAddModel =
    activeLocation === ALL_LOCATION ||
    peers.some((p) => p.address === activeLocation);

  const [consoleOpen, setConsoleOpen] = useState(false);
  const toggleConsole = useCallback(() => setConsoleOpen((o) => !o), []);
  const consoleValue = useMemo(
    () => ({open: consoleOpen, toggle: toggleConsole}),
    [consoleOpen, toggleConsole],
  );

  const [syncOpen, setSyncOpen] = useState(false);

  const downPeers = usePeerStatus();
  // A download/consolidate runs on the active peer, so its actions are disabled
  // while that peer is unreachable. The All tab targets the local machine (never
  // in the down set), so it stays enabled.
  const activePeerDown = downPeers.has(activeLocation);
  const locations: LocationTab[] = useMemo(
    () =>
      peers.map((p) => ({
        id: p.address,
        label: p.name,
        isLocal: p.isLocal ?? false,
        down: downPeers.has(p.address),
      })),
    [peers, downPeers],
  );

  const handleLocationChange = useCallback(
    (id: string) => {
      router.push(locationHref(id, peers));
    },
    [router, peers],
  );

  return (
    <ConsoleProvider value={consoleValue}>
      <AppShell
        contentPadding={0}
        topNav={
          <TopNav
            label="Main navigation"
            heading={
              <TopNavHeading
                heading="Turbo Jumbo"
                logo={
                  <NavIcon
                    icon={<CubeIcon style={{width: 16, height: 16}} />}
                  />
                }
              />
            }
            centerContent={
              <LocationTabs
                locations={locations}
                activeLocation={activeLocation}
                onLocationChange={handleLocationChange}
              />
            }
            endContent={
              <HStack gap={2} vAlign="center">
                {consolidatePeer && (
                  <Button
                    label="Consolidate with Lemonade…"
                    variant="secondary"
                    size="sm"
                    isDisabled={activePeerDown}
                    onClick={() => setSyncOpen(true)}
                  />
                )}
                {canAddModel && (
                  <AddModelMenu
                    activeLocation={activeLocation}
                    peerConfigs={peers}
                    isDisabled={activePeerDown}
                  />
                )}
                <ThemeToggle />
              </HStack>
            }
          />
        }
      >
        {children}
      </AppShell>

      <Log logLevel={logLevel} open={consoleOpen} onToggle={toggleConsole} />

      {syncOpen && consolidatePeer && (
        <LemonadeSyncModal
          syncUrl={`/api/v1/peers/${encodeURIComponent(consolidatePeer.name)}/lemonade/sync`}
          onClose={() => setSyncOpen(false)}
          onSynced={() => router.refresh()}
        />
      )}
    </ConsoleProvider>
  );
}
