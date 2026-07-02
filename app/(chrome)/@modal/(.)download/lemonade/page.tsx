import {ALL_LOCATION} from '@/lib/storage/locations';
import {LemonadeModalRoute} from '@/components/lemonade/lemonade-modal-route';

// Soft navigation to /download/lemonade: fill the @modal slot with the
// download modal over whatever page is currently rendered.
export const dynamic = 'force-dynamic';

export default function InterceptedLemonadePage() {
  return <LemonadeModalRoute location={ALL_LOCATION} />;
}
