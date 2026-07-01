import type {ReactNode} from 'react';
import {config, localPeer} from '@/lib/config';
import {parseRoute, ALL_LOCATION} from '@/lib/locations';
import {AppChrome} from '@/components/chrome/app-chrome';

export default async function LocationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{location?: string[]}>;
}) {
  const {location} = await params;
  const route = parseRoute(location, config.peers);
  // Tolerate an unknown path (page.tsx will 404): render the shell with a safe
  // default so the not-found content still appears inside it.
  const activeLocation = route?.location ?? ALL_LOCATION;
  const canDownloadLocally =
    activeLocation === ALL_LOCATION || activeLocation === localPeer?.address;

  return (
    <AppChrome
      peers={config.peers}
      activeLocation={activeLocation}
      canDownloadLocally={canDownloadLocally}
      logLevel={config.log_level ?? 'info'}
    >
      {children}
    </AppChrome>
  );
}
