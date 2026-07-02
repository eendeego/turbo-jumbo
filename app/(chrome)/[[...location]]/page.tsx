import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {config, localPeer} from '@/lib/config';
import {parseRoute} from '@/lib/locations';
import {HomeView} from '@/components/home/home-view';

export function generateMetadata(): Metadata {
  return {title: `Turbo Jumbo - ${localPeer?.name ?? 'unknown'}`};
}

// Reads the live filesystem (local + cold storage), so render per-request
// rather than prerendering at build time.
export const dynamic = 'force-dynamic';

export default async function Home({
  params,
}: {
  params: Promise<{location?: string[]}>;
}) {
  const {location} = await params;
  const route = parseRoute(location, config.peers);
  if (route === null) notFound();
  // Both download views live on explicit /download/* routes (with @modal
  // interceptors), so this page only ever renders the table. parseRoute
  // stays for validation and for AppChrome's active-location parsing.
  return <HomeView location={route.location} />;
}
