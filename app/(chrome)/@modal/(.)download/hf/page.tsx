import {ALL_LOCATION} from '@/lib/storage/locations';
import {HfDownloadModalRoute} from '@/components/hf-download/hf-download-modal-route';

// Soft navigation to /download/hf: fill the @modal slot with the download
// modal over whatever page is currently rendered.
export const dynamic = 'force-dynamic';

export default function InterceptedHfPage() {
  return <HfDownloadModalRoute location={ALL_LOCATION} />;
}
