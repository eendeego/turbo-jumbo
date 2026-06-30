import {NextResponse} from 'next/server';
import {config} from '@/lib/config';

// Expose the configured peers (name/address) to the browser.
export function GET() {
  return NextResponse.json(config.peers);
}
