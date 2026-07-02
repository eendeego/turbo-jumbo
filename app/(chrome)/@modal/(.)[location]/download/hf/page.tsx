import {config} from '@/lib/config';
import {resolveLocation, COLD_STORAGE_LOCATION} from '@/lib/locations';
import {HfDownloadModalRoute} from '@/components/hf-download/hf-download-modal-route';

// Soft navigation to /<peer>/download/hf. Invalid locations render no modal —
// the app never links to them, and a hard navigation 404s on the real route.
export const dynamic = 'force-dynamic';

export default async function InterceptedPeerHfPage({
  params,
}: {
  params: Promise<{location: string}>;
}) {
  const {location: slug} = await params;
  const location = resolveLocation([slug], config.peers);
  if (location === null || location === COLD_STORAGE_LOCATION) return null;
  return <HfDownloadModalRoute location={location} />;
}
